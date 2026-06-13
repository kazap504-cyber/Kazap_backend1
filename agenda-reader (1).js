/**
 * agenda-reader.js — KAZAP Backend
 * ══════════════════════════════════════════════════════════════════════════════
 * Lit les créneaux libres dans Firestore (agenda du vendeur) et retourne
 * un texte oral prêt à injecter dans le prompt système de Claude.
 *
 * Collections Firestore utilisées :
 *   vendors/:vendeurId → settings.availabilityRanges, settings.slotDurationMinutes
 *   appointments       → vendorId, date (YYYY-MM-DD), time (HH:MM), status
 *
 * Usage dans server.js :
 *   const { getCreneauxPourIA } = require('./agenda-reader');
 *   const texte = await getCreneauxPourIA(vendeurId);
 *   // → "demain à 10h ou à 14h30, après-demain à 9h."
 * ══════════════════════════════════════════════════════════════════════════════
 */

'use strict';

// firebase-admin est déjà initialisé dans server.js — on réutilise l'instance.
const admin = require('firebase-admin');

// ─── Constantes ────────────────────────────────────────────────────────────────

const DEFAULT_SLOT_DURATION = 60; // minutes

const DEFAULT_RANGES = [
  { start: '09:00', end: '12:00' },
  { start: '14:00', end: '18:00' }
];

const MAX_SLOTS_PER_DAY = 3; // max créneaux retournés par jour (pour garder le texte court)
const DAYS_AHEAD        = 3; // J, J+1, J+2

// ─── Utilitaires temps ─────────────────────────────────────────────────────────

function toMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function toTimeStr(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function formatHeureOrale(t) {
  const [h, m] = t.split(':').map(Number);
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`;
}

/**
 * Date locale Bénin (UTC+1) au format YYYY-MM-DD.
 * Render tourne en UTC → on décale de +1h.
 */
function getLocalDate(daysOffset = 0) {
  const OFFSET_H = 1; // UTC+1 Bénin / Togo / Niger
  const now   = new Date();
  const local = new Date(now.getTime() + OFFSET_H * 3600 * 1000);
  local.setUTCDate(local.getUTCDate() + daysOffset);
  return local.toISOString().split('T')[0];
}

function getLabelJour(offset) {
  if (offset === 0) return "aujourd'hui";
  if (offset === 1) return 'demain';
  return 'après-demain';
}

// ─── Lecture Firestore ─────────────────────────────────────────────────────────

async function getVendorConfig(vendeurId) {
  const db   = admin.firestore();
  const snap = await db.collection('vendors').doc(vendeurId).get();

  if (!snap.exists) {
    console.warn(`[agenda-reader] Vendor ${vendeurId} introuvable — config par défaut`);
    return { availabilityRanges: DEFAULT_RANGES, slotDurationMinutes: DEFAULT_SLOT_DURATION };
  }

  const settings = snap.data()?.settings || {};
  return {
    availabilityRanges:   settings.availabilityRanges?.length ? settings.availabilityRanges : DEFAULT_RANGES,
    slotDurationMinutes:  Number(settings.slotDurationMinutes) || DEFAULT_SLOT_DURATION
  };
}

async function getBookedTimes(vendeurId, dateStr) {
  const db = admin.firestore();
  try {
    const snap = await db.collection('appointments')
      .where('vendorId', '==', vendeurId)
      .where('date',     '==', dateStr)
      .get();

    return snap.docs
      .map(d => d.data())
      .filter(a => a.status !== 'cancelled')
      .map(a => a.time)
      .filter(Boolean);
  } catch (e) {
    console.error(`[agenda-reader] Erreur lecture appointments (${dateStr}) :`, e.message);
    return []; // fail-open : on suppose aucun RDV
  }
}

// ─── Calcul créneaux libres ────────────────────────────────────────────────────

function calcCreneauxLibres(bookedTimes, ranges, slotDuration, maxSlots = MAX_SLOTS_PER_DAY) {
  const booked   = new Set(bookedTimes);
  const allSlots = [];

  for (const range of ranges) {
    let cur       = toMinutes(range.start);
    const endMin  = toMinutes(range.end);
    while (cur + slotDuration <= endMin) {
      allSlots.push(toTimeStr(cur));
      cur += slotDuration;
    }
  }

  return allSlots.filter(s => !booked.has(s)).slice(0, maxSlots);
}

// ─── Formatage texte oral ─────────────────────────────────────────────────────

function formatCreneauxTexteOral(joursSlotsLibres) {
  const parties = [];

  for (const { label, slots } of joursSlotsLibres) {
    if (!slots.length) continue;
    const heures = slots.map(formatHeureOrale);
    let partie;
    if (heures.length === 1) {
      partie = `${label} à ${heures[0]}`;
    } else {
      const derniere = heures.pop();
      partie = `${label} à ${heures.join(', à ')} ou à ${derniere}`;
    }
    parties.push(partie);
  }

  if (parties.length === 0) {
    return 'aucun créneau disponible sur les trois prochains jours';
  }

  return parties.join(', ') + '.';
}

// ─── Export principal ─────────────────────────────────────────────────────────

/**
 * getCreneauxPourIA
 * Point d'entrée unique. Appelé depuis server.js lors de l'ouverture du
 * WebSocket media-stream, AVANT le premier appel à Claude.
 *
 * @param {string} vendeurId — UID Firebase du vendeur
 * @returns {Promise<string>} Texte oral prêt à injecter dans {creneaux_agenda}
 */
async function getCreneauxPourIA(vendeurId) {
  if (!vendeurId) {
    console.warn('[agenda-reader] vendeurId manquant');
    return 'agenda non disponible';
  }

  try {
    const { availabilityRanges, slotDurationMinutes } = await getVendorConfig(vendeurId);

    const joursSlotsLibres = [];
    for (let offset = 0; offset < DAYS_AHEAD; offset++) {
      const dateStr    = getLocalDate(offset);
      const label      = getLabelJour(offset);
      const booked     = await getBookedTimes(vendeurId, dateStr);
      const slots      = calcCreneauxLibres(booked, availabilityRanges, slotDurationMinutes);
      joursSlotsLibres.push({ label, slots });
    }

    const texte = formatCreneauxTexteOral(joursSlotsLibres);
    console.log(`[agenda-reader] Créneaux ${vendeurId} : ${texte}`);
    return texte;

  } catch (e) {
    console.error('[agenda-reader] Erreur fatale :', e.message);
    return 'agenda temporairement indisponible';
  }
}

module.exports = { getCreneauxPourIA };
