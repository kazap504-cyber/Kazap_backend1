/**
 * KAZAP — reminders.js
 * Moteur de rappels de rendez-vous cote serveur (Phase 6).
 *
 * Pourquoi : le moteur existant (index.html, _startReminderEngine) ne tourne que tant
 * que le tableau de bord du vendeur est ouvert dans un navigateur. Ce module fait le
 * meme travail depuis le serveur, donc les rappels partent meme si le vendeur est
 * hors ligne, a condition que le serveur soit eveille (hebergement non endormi).
 *
 * Ce qu'il envoie (toutes les 60 s, fenetres identiques au moteur existant) :
 *   - client : SMS 24 h avant (23-25 h) et 1 h avant (55-65 min), via sms-provider.js.
 *     Memes regles que /sms/send : plan Pro/Premium ou essai actif, quota de 20 SMS de
 *     l'essai. Le client doit avoir un numero au format international (+...).
 *   - vendeur : notification push 1 h avant (gratuite, tous plans).
 *
 * Idempotence : memes champs Firestore que le moteur du navigateur (reminderSent pour
 * 24 h, reminder1hSent pour 1 h), reserves par transaction : un rappel ne part qu'une
 * fois, meme avec plusieurs instances du serveur ou si le tableau de bord est ouvert.
 * En cas d'echec d'envoi, le champ est remis a false et l'envoi est retente (3 tentatives
 * maximum, espacees de 3 minutes).
 *
 * Fuseau horaire : les rendez-vous sont stockes sans fuseau (date + heure locales).
 * Fuseau utilise : vendors/{id}.settings.timezone, sinon KAZAP_DEFAULT_TZ, sinon
 * Africa/Porto-Novo (UTC+1, sans heure d'ete).
 *
 * Toutes les dependances sont injectees par server.js (creerRappels(deps)).
 */

'use strict';

const H = 3600 * 1000;
const MIN = 60 * 1000;

const CFG = {
  tickMs:         60 * 1000,
  rafraichissementMs: 5 * 60 * 1000,   // relecture de la liste des RDV proches (limite le nombre de lectures Firestore)
  cacheVendeurMs: 5 * 60 * 1000,
  fenetre24h:     [23 * H, 25 * H],
  fenetre1h:      [55 * MIN, 65 * MIN],
  maxTentatives:  3,
  espacementMs:   3 * MIN,
  fuseauParDefaut: process.env.KAZAP_DEFAULT_TZ || 'Africa/Porto-Novo'
};

// ── Fuseaux horaires (sans bibliotheque : Intl) ──────────────────────────────
const _formateurs = new Map();
function _formateur(tz) {
  let f = _formateurs.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    _formateurs.set(tz, f);
  }
  return f;
}

/** Decalage (ms) du fuseau par rapport a UTC a l'instant donne. */
function _decalageMs(epoch, tz) {
  const p = {};
  _formateur(tz).formatToParts(new Date(epoch)).forEach(x => { if (x.type !== 'literal') p[x.type] = Number(x.value); });
  const commeUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return commeUtc - Math.floor(epoch / 1000) * 1000;
}

/** Instant UTC (ms) correspondant a une date 'YYYY-MM-DD' et une heure 'HH:MM' locales dans le fuseau. NaN si invalide. */
function epochDansFuseau(date, heure, tz) {
  const [y, m, d] = String(date).split('-').map(Number);
  const [hh, mm] = String(heure || '00:00').split(':').map(Number);
  if ([y, m, d, hh, mm].some(n => !Number.isFinite(n))) return NaN;
  const approx = Date.UTC(y, m - 1, d, hh, mm);
  const off1 = _decalageMs(approx, tz);
  let t = approx - off1;
  const off2 = _decalageMs(t, tz);
  if (off2 !== off1) t = approx - off2;   // changement d'heure entre les deux instants
  return t;
}

function _fuseauValide(tz) {
  if (typeof tz !== 'string' || !tz) return null;
  try { _formateur(tz); return tz; } catch (e) { return null; }
}

function _ymd(epoch) { return new Date(epoch).toISOString().slice(0, 10); }

/** Garde uniquement un numero international plausible (+...). null sinon. */
function telephoneInternational(valeur) {
  if (typeof valeur !== 'string') return null;
  let tel = valeur.replace(/[^\d+]/g, '');
  if (tel.startsWith('00')) tel = '+' + tel.slice(2);
  if (!tel.startsWith('+')) return null;
  const chiffres = tel.slice(1).replace(/\D/g, '');
  return chiffres.length >= 8 && chiffres.length <= 15 ? '+' + chiffres : null;
}

function _dateLisible(date, lang) {
  const [y, m, d] = String(date).split('-').map(Number);
  try {
    return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(lang === 'en' ? 'en-GB' : 'fr-FR',
      { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  } catch (e) { return String(date); }
}

function messageClient(appt, vd, type) {
  const lang = (vd.settings && vd.settings.lang) === 'en' ? 'en' : 'fr';
  const boutique = vd.boutiqueName || (lang === 'en' ? 'your provider' : 'votre prestataire');
  const jour = _dateLisible(appt.date, lang);
  if (lang === 'en') {
    const delai = type === '24h' ? 'tomorrow' : 'in 1 hour';
    return `KAZAP | Appointment reminder - ${boutique}\nYou have an appointment ${delai} (${jour} at ${appt.time}).\nIf you cannot attend, please contact ${boutique} directly.`;
  }
  const delai = type === '24h' ? 'demain' : 'dans 1 heure';
  return `KAZAP | Rappel RDV — ${boutique}\nVous avez un rendez-vous ${delai} (${jour} à ${appt.time}).\nEn cas d'empêchement, contactez ${boutique} directement.`;
}

function creerRappels(deps) {
  const {
    db, sendFCMPush, envoyerSMS,
    accesSmsAutorise, quotaSmsDisponible, incrementerUsageEssai, compteEstBloque
  } = deps;
  const log = deps.log || console;
  const maintenant = deps.maintenant || (() => Date.now());

  let minuteur = null;
  let enCours = false;
  const ignoresLogues = new Set();
  // Evite de relire Firestore a chaque minute : liste des RDV proches et vendeurs gardes en memoire
  let listeRdv = { at: 0, docs: [] };
  const vendeursCache = new Map();   // vendorId -> { vd, at }

  function _logUneFois(cle, msg) {
    if (ignoresLogues.has(cle)) return;
    if (ignoresLogues.size > 5000) ignoresLogues.clear();
    ignoresLogues.add(cle);
    log.warn(msg);
  }

  async function _vendeur(vendorId, now) {
    const c = vendeursCache.get(vendorId);
    if (c && now - c.at < CFG.cacheVendeurMs) return c.vd;
    let vd = null;
    try {
      const s = await db.collection('vendors').doc(vendorId).get();
      vd = s.exists ? s.data() : null;
    } catch (e) {
      log.error('[rappels] lecture vendeur :', e.message);
      return c ? c.vd : null;
    }
    if (vendeursCache.size > 2000) vendeursCache.clear();
    vendeursCache.set(vendorId, { vd, at: now });
    return vd;
  }

  /** Reserve atomiquement un rappel. Retourne true si CE processus l'a obtenu. */
  async function _reserver(ref, appt, champ, champTentatives, champDernier, now) {
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return 'annule';
      const d = snap.data() || {};
      // La liste en memoire peut avoir quelques minutes de retard : on revalide sur le document frais
      if (d.status === 'cancelled' || d.date !== appt.date || d.time !== appt.time) return 'annule';
      if (d[champ]) return 'deja';
      const n = Number(d[champTentatives] || 0);
      const dernier = Number(d[champDernier] || 0);
      if (n >= CFG.maxTentatives || (dernier && now - dernier < CFG.espacementMs)) return 'limite';
      tx.update(ref, { [champ]: true, [champTentatives]: n + 1, [champDernier]: now });
      return 'ok';
    });
  }

  async function rappelClient(docRef, appt, vd, type, now) {
    const champ = type === '24h' ? 'reminderSent' : 'reminder1hSent';
    const champN = type === '24h' ? 'reminder24hAttempts' : 'reminder1hAttempts';
    const champT = type === '24h' ? 'reminder24hLastAt' : 'reminder1hLastAt';
    if (appt[champ]) return;
    if (Number(appt[champN] || 0) >= CFG.maxTentatives) return;

    const tel = telephoneInternational(appt.clientPhone);
    if (!tel) {
      if (appt.clientPhone) _logUneFois(`tel:${appt.id}`, `[rappels] RDV ${appt.id} : numero client non international, SMS ignore.`);
      return;
    }
    if (!accesSmsAutorise(vd)) return;                       // plan Basique ou compte bloque
    if (!quotaSmsDisponible(vd)) return;                     // quota de l'essai deja atteint (copie en memoire)
    // Quota de l'essai : relu a chaque envoi, car plusieurs SMS peuvent partir dans le meme passage
    let vdFrais = vd;
    try { const s = await db.collection('vendors').doc(appt.vendorId).get(); if (s.exists) vdFrais = s.data(); } catch (e) { /* garde la copie du passage */ }
    if (!quotaSmsDisponible(vdFrais)) return;

    const resa = await _reserver(docRef, appt, champ, champN, champT, now);
    if (resa === 'deja') { appt[champ] = true; return; }
    if (resa === 'annule') { appt.status = 'cancelled'; return; }
    if (resa !== 'ok') return;
    appt[champ] = true;
    try {
      await envoyerSMS({
        to:   tel,
        body: messageClient(appt, vd, type),
        from: (vd.voip && vd.voip.twilioPhoneNumber) || undefined
      });
      await incrementerUsageEssai(appt.vendorId, vdFrais, 'sms');
      log.log(`[rappels] Rappel ${type} envoye -> ${tel} (RDV ${appt.id})`);
    } catch (err) {
      log.error(`[rappels] Echec rappel ${type} RDV ${appt.id} :`, err && err.message);
      appt[champ] = false;
      appt[champN] = Number(appt[champN] || 0) + 1; appt[champT] = now;
      try { await docRef.update({ [champ]: false }); } catch (e) { /* sera retente ou abandonne apres 3 essais */ }
    }
  }

  async function rappelVendeur(docRef, appt, vd, now) {
    if (appt.vendorReminder1hSent) return;
    let reserve = false;
    try {
      reserve = await db.runTransaction(async (tx) => {
        const snap = await tx.get(docRef);
        if (!snap.exists) return false;
        const d = snap.data() || {};
        if (d.status === 'cancelled' || d.date !== appt.date || d.time !== appt.time || d.vendorReminder1hSent) return false;
        tx.update(docRef, { vendorReminder1hSent: true });
        return true;
      });
    } catch (e) { log.error('[rappels] reservation push vendeur :', e.message); return; }
    appt.vendorReminder1hSent = true;
    if (!reserve) return;
    const lang = (vd.settings && vd.settings.lang) === 'en' ? 'en' : 'fr';
    const qui = appt.clientName || (lang === 'en' ? 'Customer' : 'Client');
    const titre = lang === 'en' ? 'Appointment in 1 hour' : 'Rendez-vous dans 1 heure';
    const corps = `${qui} — ${appt.time}${appt.title ? ' — ' + appt.title : ''}`;
    try {
      await sendFCMPush(appt.vendorId, titre, corps, { type: 'rdv_reminder', apptId: appt.id, clickUrl: '/dashboard?section=agenda' });
    } catch (e) { log.warn('[rappels] push vendeur :', e && e.message); }
  }

  async function _rafraichirListe(now) {
    // Seuls les RDV des prochaines 25 h comptent (fenetre maximale 25 h) ; marge de 14 h pour les fuseaux
    const d0 = _ymd(now - 14 * H), d1 = _ymd(now + 25 * H + 14 * H);
    const snap = await db.collection('appointments').where('date', '>=', d0).where('date', '<=', d1).get();
    listeRdv = { at: now, docs: snap.docs.map(doc => ({ id: doc.id, ...(doc.data() || {}) })) };
  }

  async function tick() {
    if (enCours) return;
    enCours = true;
    try {
      const now = maintenant();
      if (now - listeRdv.at >= CFG.rafraichissementMs) await _rafraichirListe(now);
      for (const appt of listeRdv.docs) {
        if (!appt.vendorId || !appt.date || !appt.time || appt.status === 'cancelled') continue;
        const vd = await _vendeur(appt.vendorId, now);
        if (!vd || compteEstBloque(vd)) continue;
        const tz = _fuseauValide(vd.settings && vd.settings.timezone) || _fuseauValide(CFG.fuseauParDefaut) || 'UTC';
        const rdvMs = epochDansFuseau(appt.date, appt.time, tz);
        if (!Number.isFinite(rdvMs)) continue;
        const diff = rdvMs - now;
        const dans24h = diff > CFG.fenetre24h[0] && diff < CFG.fenetre24h[1];
        const dans1h  = diff > CFG.fenetre1h[0]  && diff < CFG.fenetre1h[1];
        if (!dans24h && !dans1h) continue;
        const ref = db.collection('appointments').doc(appt.id);
        try {
          if (dans24h) await rappelClient(ref, appt, vd, '24h', now);
          if (dans1h) {
            await rappelClient(ref, appt, vd, '1h', now);
            await rappelVendeur(ref, appt, vd, now);
          }
        } catch (e) {
          log.error(`[rappels] RDV ${appt.id} :`, e && e.message);
        }
      }
    } catch (err) {
      listeRdv.at = 0;   // reessaie de relire la liste au prochain passage
      log.error('[rappels] Erreur du passage :', err && err.message);
    } finally {
      enCours = false;
    }
  }

  function demarrer() {
    if (minuteur) return;
    minuteur = setInterval(tick, CFG.tickMs);
    if (minuteur.unref) minuteur.unref();   // ne retient pas le processus a l'arret
    const premier = setTimeout(tick, 5000);  // premier passage peu apres le demarrage (reveil de l'hebergement)
    if (premier.unref) premier.unref();
    log.log('[rappels] Moteur de rappels cote serveur demarre (toutes les 60 s)');
  }
  function arreter() { if (minuteur) { clearInterval(minuteur); minuteur = null; } }

  return { demarrer, arreter, tick, etat: () => ({ serverEngine: !!minuteur }) };
}

module.exports = { creerRappels, epochDansFuseau, telephoneInternational, messageClient, _cfg: CFG };
