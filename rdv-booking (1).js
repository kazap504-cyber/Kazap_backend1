/**
 * KAZAP — rdv-booking.js
 * Module de prise de rendez-vous par l'IA vocale (M-04).
 *
 * Ce module NE remplace PAS claude-agent.js : il fournit des helpers
 * utilisés par server.js une fois que Claude (genererReponseIA) a détecté
 * intention === "rdv". La machine à états RDV est gérée côté server.js
 * via session.rdvState, pour rester synchronisée avec session.historique
 * et le flux Deepgram → Claude → TwiML déjà en place.
 *
 * États (session.rdvState.etape) :
 *   null             → pas de flux RDV en cours
 *   PROPOSE_CRENEAU  → l'IA vient de proposer 2-3 créneaux, attend le choix
 *   CONFIRME         → l'IA a reformulé le créneau choisi, attend oui/non
 *   TERMINE          → RDV enregistré (ou flux abandonné), retour à la conversation libre
 *
 * Usage dans server.js :
 *   const RdvBooking = require('./rdv-booking');
 *   const proposals  = await RdvBooking.buildProposals(vendeurId);
 *   const chosen     = RdvBooking.parseClientChoice(transcription, session.rdvState.proposals);
 *   await RdvBooking.saveAppointment({ vendorId, callSid, clientName, clientPhone, date, time, motif });
 *   await RdvBooking.sendRdvSms({ vendorId, clientPhone, clientName, date, time });
 */

'use strict';

const admin = require('firebase-admin'); // déjà initialisé dans server.js

const BACKEND_SMS_URL = process.env.BACKEND_URL || 'https://kazap-backend1.onrender.com';

// fetch global (Node 18+) ; fallback sur node-fetch si besoin
const fetchFn = (typeof fetch === 'function')
  ? fetch
  : require('node-fetch');

const ORDINALS = ['premier', 'deuxième', 'troisième'];

// ─── Helpers agenda ──────────────────────────────────────────────────────────

const DEFAULT_RANGES = [
  { start: '09:00', end: '12:00' },
  { start: '14:00', end: '18:00' }
];
const DEFAULT_SLOT_DURATION = 60;

function toMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function toTimeStr(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * Calcule les créneaux libres pour une date donnée en lisant Firestore.
 * Retourne un tableau de chaînes "HH:MM".
 */
async function getAvailableSlots(vendorId, dateStr) {
  const db = admin.firestore();

  const vendorSnap = await db.collection('vendors').doc(vendorId).get();
  if (!vendorSnap.exists) return [];
  const vendor = vendorSnap.data();

  const availabilityRanges = vendor.settings?.availabilityRanges?.length
    ? vendor.settings.availabilityRanges
    : DEFAULT_RANGES;
  const slotDuration = Number(vendor.settings?.slotDurationMinutes) || DEFAULT_SLOT_DURATION;

  let bookedTimes = [];
  try {
    const snap = await db.collection('appointments')
      .where('vendorId', '==', vendorId)
      .where('date', '==', dateStr)
      .get();
    bookedTimes = snap.docs
      .map(d => d.data())
      .filter(a => a.status !== 'cancelled')
      .map(a => a.time)
      .filter(Boolean);
  } catch (e) {
    console.warn('[rdv-booking] getAvailableSlots — lecture appointments :', e.message);
  }

  const allSlots = [];
  for (const range of availabilityRanges) {
    let cur = toMinutes(range.start);
    const end = toMinutes(range.end);
    while (cur + slotDuration <= end) {
      allSlots.push(toTimeStr(cur));
      cur += slotDuration;
    }
  }

  return allSlots.filter(s => !bookedTimes.includes(s)).slice(0, 3);
}

/**
 * Construit les propositions orales pour 2-3 créneaux sur demain + après-demain.
 * Retourne { slots: [{date, time, label}], text: string }
 */
async function buildProposals(vendorId) {
  const OFFSET_H = 1; // UTC+1 Bénin / Togo / Niger (cf. agenda-reader.js)
  const now = new Date(Date.now() + OFFSET_H * 3600 * 1000);

  const tomorrow  = new Date(now); tomorrow.setUTCDate(now.getUTCDate() + 1);
  const afterTmrw = new Date(now); afterTmrw.setUTCDate(now.getUTCDate() + 2);

  const toISO    = d => d.toISOString().split('T')[0];
  const dayLabel = d => d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

  const formatHeureOrale = t => {
    const [h, m] = t.split(':').map(Number);
    return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`;
  };

  let slots = [];

  const slotsTmrw = await getAvailableSlots(vendorId, toISO(tomorrow));
  for (const t of slotsTmrw) {
    slots.push({ date: toISO(tomorrow), time: t, label: `demain à ${formatHeureOrale(t)}` });
    if (slots.length >= 2) break;
  }

  if (slots.length < 3) {
    const slotsAfter = await getAvailableSlots(vendorId, toISO(afterTmrw));
    for (const t of slotsAfter) {
      slots.push({ date: toISO(afterTmrw), time: t, label: `${dayLabel(afterTmrw)} à ${formatHeureOrale(t)}` });
      if (slots.length >= 3) break;
    }
  }

  if (slots.length === 0) {
    return {
      slots: [],
      text: "Je suis désolée, je n'ai aucun créneau disponible dans les prochains jours. Souhaitez-vous que je transmette votre demande directement à l'équipe ?"
    };
  }

  const proposals = slots.map((s, i) => `${ORDINALS[i]}, ${s.label}`).join(', ou le ');
  const text = slots.length === 1
    ? `Je peux vous proposer ${slots[0].label}. Cela vous convient-il ?`
    : `Je peux vous proposer le ${proposals}. Lequel vous convient le mieux ?`;

  return { slots, text };
}

// ─── Parsing de la réponse client ────────────────────────────────────────────

const OUI_PATTERNS = /\b(oui|yes|exact|c'?est\s*(ça|bien|bon|correct)|parfait|d'?accord|ok|super|nickel|confirme|valide)\b/i;
const NON_PATTERNS = /\b(non|no|pas|autre|changer?|différent|autre\s*chose|négatif|pas\s*celui[-\s]?là|pas\s*ça)\b/i;

/**
 * Tente de résoudre la réponse du client vers un slot proposé.
 * @param {string} text   - Transcription client
 * @param {Array}  slots  - [{date, time, label}]
 * @returns {object|null} - Slot correspondant ou null si ambigu
 */
function parseClientChoice(text, slots) {
  if (!text || !slots?.length) return null;
  const t = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Ordinal : "le premier", "1", "un"...
  const ordinalMap = [
    { re: /\b(premier|prem|1er|1\b|un\b)/, idx: 0 },
    { re: /\b(deuxieme|second|2\b|deux\b)/, idx: 1 },
    { re: /\b(troisieme|3\b|trois\b)/, idx: 2 },
  ];
  for (const { re, idx } of ordinalMap) {
    if (re.test(t) && slots[idx]) return slots[idx];
  }

  // Heure explicite : "10h", "14h30", "dix heures"
  const hourMatch = t.match(/\b(\d{1,2})[h:]\s*(\d{0,2})\b/);
  if (hourMatch) {
    const hStr = hourMatch[1].padStart(2, '0');
    const mStr = (hourMatch[2] || '00').padStart(2, '0');
    const candidate = `${hStr}:${mStr}`;
    const found = slots.find(s => s.time === candidate);
    if (found) return found;
    const foundH = slots.find(s => s.time.startsWith(hStr + ':'));
    if (foundH) return foundH;
  }

  // Jour de la semaine cité
  const jours = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
  for (const jour of jours) {
    if (t.includes(jour)) {
      const found = slots.find(s => {
        const labelN = s.label.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        return labelN.includes(jour);
      });
      if (found) return found;
    }
  }

  // "demain matin" / "demain après-midi"
  if (/demain\s*(matin|am|mat)\b/.test(t)) {
    const morn = slots.find(s => s.label.includes('demain') && parseInt(s.time, 10) < 12);
    if (morn) return morn;
  }
  if (/demain\s*(apr[eè]s[-\s]?midi|pm|soir)\b/.test(t)) {
    const aft = slots.find(s => s.label.includes('demain') && parseInt(s.time, 10) >= 12);
    if (aft) return aft;
  }
  // "demain" seul, sans précision d'heure → si un seul slot demain, le prendre
  if (/\bdemain\b/.test(t) && !hourMatch) {
    const tmrwSlots = slots.filter(s => s.label.includes('demain'));
    if (tmrwSlots.length === 1) return tmrwSlots[0];
  }

  return null;
}

function ouiConfirme(text) {
  return OUI_PATTERNS.test((text || '').toLowerCase());
}
function nonRefuse(text) {
  return NON_PATTERNS.test((text || '').toLowerCase());
}

/**
 * Construit le texte de relance listant les propositions (ex. après réponse ambiguë).
 */
function formatRelance(slots) {
  const labels = slots.map((s, i) => `le ${ORDINALS[i]}, ${s.label}`).join(', ou ');
  return `Excusez-moi, je n'ai pas bien compris. Souhaitez-vous ${labels} ?`;
}

// ─── Écriture Firestore & SMS ─────────────────────────────────────────────────

/**
 * Enregistre le RDV dans Firestore et met à jour ia_orders (rdvTaken = true).
 */
async function saveAppointment({ vendorId, callSid, clientName, clientPhone, date, time, motif }) {
  const db = admin.firestore();

  const data = {
    vendorId,
    clientName:  clientName  || 'Client inconnu',
    clientPhone: clientPhone || '',
    title:       motif       || "RDV pris par l'IA",
    date,
    time,
    status:         'confirmed',
    note:           "Rendez-vous pris automatiquement lors d'un appel IA",
    source:         'ia',
    duration:       60,
    reminderSent:   false,
    reminder1hSent: false,
    createdAt:      admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
  };

  const ref = await db.collection('appointments').add(data);
  console.log(`✅ [rdv-booking] RDV enregistré → appointments/${ref.id}`);

  // Marquer rdvTaken=true sur l'enregistrement ia_orders de cet appel
  if (callSid) {
    try {
      const iaSnap = await db.collection('ia_orders')
        .where('callSid', '==', callSid)
        .limit(1)
        .get();
      if (!iaSnap.empty) {
        await iaSnap.docs[0].ref.update({
          type:          'rdv',
          rdvTaken:      true,
          appointmentId: ref.id,
          updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    } catch (e) {
      console.warn('[rdv-booking] Impossible de mettre à jour ia_orders :', e.message);
    }
  }

  return { firestoreId: ref.id, data };
}

/**
 * Envoie le SMS de confirmation au client via l'endpoint /sms/send existant.
 * Non bloquant : les erreurs sont loguées mais n'interrompent pas le flux.
 */
async function sendRdvSms({ vendorId, clientPhone, clientName, date, time }) {
  if (!clientPhone || clientPhone === 'unknown' || !vendorId) return;

  try {
    const db = admin.firestore();
    const vendorSnap = await db.collection('vendors').doc(vendorId).get();
    const boutique   = vendorSnap.data()?.boutiqueName || 'votre prestataire';

    const dt      = new Date(`${date}T${time}`);
    const dateStr = dt.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    const message = `📅 KAZAP | Bonjour ${clientName || ''}, votre rendez-vous chez ${boutique} est confirmé pour le ${dateStr} à ${time}. En cas d'empêchement, contactez ${boutique} directement.`;

    const res = await fetchFn(`${BACKEND_SMS_URL}/sms/send`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ vendorId, to: clientPhone, message }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => res.status);
      throw new Error(`SMS backend ${res.status}: ${err}`);
    }
    console.log(`✅ [rdv-booking] SMS RDV envoyé → ${clientPhone}`);
  } catch (e) {
    console.warn('[rdv-booking] SMS non envoyé :', e.message);
  }
}

module.exports = {
  buildProposals,
  parseClientChoice,
  ouiConfirme,
  nonRefuse,
  formatRelance,
  saveAppointment,
  sendRdvSms,
  // Exposé pour tests
  _getAvailableSlots: getAvailableSlots,
};
