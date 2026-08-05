/**
 * KAZAP — firestore-writer.js
 * Module d'écriture Firestore pour les commandes et RDV détectés par l'IA vocale.
 *
 * Collections utilisées :
 *   - ia_orders  : commandes / RDV / appels détectés par l'IA
 *
 * Fonctions exportées :
 *   - ecrireIaOrder(params)          → Crée ou met à jour un document ia_orders
 *                                       (Partie 5/8 Volet 4/4 : n'écrit que si
 *                                       le plan du vendeur autorise l'IA —
 *                                       voir _accesIAAutorise ci-dessous)
 *   - mettreAJourStatutAppel(callSid, data) → Met à jour le statut d'un appel par CallSid
 */

'use strict';

const admin = require('firebase-admin');

/**
 * Retourne l'instance Firestore (Firebase Admin doit être déjà initialisé dans server.js).
 */
function _db() {
  return admin.firestore();
}

// ════════════════════════════════════════════════════════════════════════════
// GATING PLAN IA — Partie 5/8, Volet 4/4
// ════════════════════════════════════════════════════════════════════════════
// Copie exacte (miroir) des fonctions de gating de server.js (_normaliserPlan,
// _tsEnMs, _essaiEncoreActif, _planEstActif, _compteEstBloque, _accesIAAutorise
// — introduites/corrigées en Partie 3/8). Dupliquées ici plutôt que require()
// depuis server.js pour éviter une dépendance circulaire (server.js fait déjà
// require('./firestore-writer') au chargement). Toute évolution de ces règles
// dans server.js doit être répercutée ici à l'identique — même précédent que
// dans migration-plans.js.
// ════════════════════════════════════════════════════════════════════════════

function _normaliserPlan(vendeurData) {
  const validPlans = ['basique', 'pro', 'premium', 'trial', 'free'];
  const raw = vendeurData?.plan;
  let plan = validPlans.includes(raw) ? raw : 'free';
  if (plan === 'free' && !vendeurData?.planActivatedAt) plan = 'trial';
  return plan;
}

function _tsEnMs(ts) {
  if (!ts) return null;
  if (typeof ts.seconds === 'number') return ts.seconds * 1000;
  if (typeof ts.toDate === 'function') return ts.toDate().getTime();
  const d = new Date(ts).getTime();
  return isNaN(d) ? null : d;
}

function _essaiEncoreActif(vendeurData) {
  const plan = _normaliserPlan(vendeurData);
  if (plan !== 'trial' && plan !== 'free') return false;
  const refMs = _tsEnMs(vendeurData?.planActivatedAt) || _tsEnMs(vendeurData?.createdAt);
  if (!refMs) return true;
  return Date.now() < refMs + 14 * 86400000;
}

function _planEstActif(vendeurData) {
  const plan = _normaliserPlan(vendeurData);
  if (plan === 'trial' || plan === 'free') return _essaiEncoreActif(vendeurData);
  const expMs = _tsEnMs(vendeurData?.planExpiresAt);
  if (!expMs) return true;
  return expMs >= Date.now();
}

function _compteEstBloque(vendeurData) {
  return !_planEstActif(vendeurData);
}

/** Reproduit _accesIAAutorise (server.js, Partie 3/8) : Pro/Premium → accès,
 *  essai actif (trial/free dans les 14 jours) → accès, sinon (Basique ou
 *  essai expiré, ou compte bloqué) → pas d'accès. */
function _accesIAAutorise(vendeurData) {
  if (_compteEstBloque(vendeurData)) return false;
  if (_essaiEncoreActif(vendeurData)) return true;
  const plan = _normaliserPlan(vendeurData);
  return plan === 'pro' || plan === 'premium';
}

/**
 * _resumeAppelAutorise
 * Charge le vendeur (vendeurId) et applique _accesIAAutorise pour déterminer
 * si l'écriture du résumé d'appel (ia_orders) est permise pour son plan.
 * En cas d'erreur technique de lecture Firestore, reste permissif (comme
 * verifierCompteActif / _quotaIADisponible côté server.js) plutôt que de
 * bloquer une écriture légitime sur un incident transitoire.
 */
async function _resumeAppelAutorise(vendeurId) {
  try {
    const snap = await _db().collection('vendors').doc(vendeurId).get();
    if (!snap.exists) return true; // pas de vendeur connu : pas à ecrireIaOrder de trancher, laisse passer
    return _accesIAAutorise(snap.data());
  } catch (err) {
    console.error(`[Gating ia_orders] Erreur lecture vendor (vendeurId: ${vendeurId}) :`, err.message);
    return true;
  }
}
// === FIN GATING PLAN IA =======================================================

/**
 * ecrireIaOrder
 * Crée un document dans la collection `ia_orders`.
 * Si un document avec le même callSid existe déjà, il est mis à jour (merge).
 *
 * Structure du document ia_orders :
 * {
 *   callSid:       string,         // SID Twilio de l'appel
 *   vendeurId:     string,         // UID Firestore du vendeur
 *   type:          string,         // 'commande' | 'rdv' | 'info' | 'appel' | 'inconnu'
 *   statut:        string,         // 'en_cours' | 'nouveau' | 'ia_handled' | 'termine'
 *   client: {
 *     nom:         string|null,    // Nom du client (si fourni pendant l'appel)
 *     telephone:   string|null,    // Numéro de téléphone du client (From Twilio)
 *   },
 *   details:       string|null,    // Résumé de la commande ou du RDV (texte libre)
 *   transcription: string|null,    // Transcription complète de l'appel
 *   durationSec:   number|null,    // Durée de l'appel en secondes
 *   createdAt:     Timestamp,      // Date de création (serverTimestamp)
 *   updatedAt:     Timestamp,      // Date de dernière mise à jour
 *   source:        'ia_vocal'      // Toujours 'ia_vocal' pour distinguer des autres commandes
 * }
 *
 * @param {Object} params
 * @param {string}      params.callSid       — SID Twilio de l'appel (clé primaire)
 * @param {string}      params.vendeurId     — UID Firestore du vendeur
 * @param {string}      params.type          — Type : 'commande' | 'rdv' | 'info' | 'appel' | 'inconnu'
 * @param {string}      params.statut        — Statut : 'en_cours' | 'nouveau' | 'ia_handled' | 'termine'
 * @param {Object}      params.client        — { nom, telephone }
 * @param {string|null} params.details       — Résumé de la demande
 * @param {string|null} params.transcription — Transcription STT de l'appel
 * @param {number|null} params.durationSec   — Durée de l'appel en secondes
 * @returns {Promise<string>} — ID du document Firestore créé ou mis à jour
 */
async function ecrireIaOrder({
  callSid,
  vendeurId,
  type        = 'inconnu',
  statut      = 'nouveau',
  client      = { nom: null, telephone: null },
  details     = null,
  transcription = null,
  durationSec = null
}) {
  if (!callSid) {
    throw new Error('ecrireIaOrder : callSid est requis');
  }
  if (!vendeurId) {
    throw new Error('ecrireIaOrder : vendeurId est requis');
  }

  // ── Gating plan (Partie 5/8, Volet 4/4) ──────────────────────────────────
  // Même règle que genererReponseIAEcrit (Volet 3/4) : Basique = pas d'accès
  // IA → aucune écriture du résumé d'appel dans ia_orders. Comportement de
  // repli identique : on n'écrit rien et on journalise, sans lever d'erreur,
  // pour ne jamais faire échouer l'appelant (le flux d'appel Twilio doit
  // continuer normalement même si le résumé n'est pas enregistré).
  const autorise = await _resumeAppelAutorise(vendeurId);
  if (!autorise) {
    console.warn(`⛔ ia_orders — écriture refusée (plan insuffisant) — callSid: ${callSid} | vendeurId: ${vendeurId}`);
    return null;
  }

  const db = _db();
  const maintenant = admin.firestore.FieldValue.serverTimestamp();

  // Utiliser le CallSid comme ID de document pour garantir l'unicité par appel
  // et permettre les mises à jour ultérieures (merge)
  const docId  = callSid;
  const docRef = db.collection('ia_orders').doc(docId);

  const snap = await docRef.get();

  if (snap.exists) {
    // Document existant → mise à jour partielle (ne pas écraser createdAt)
    const donneesMaj = {
      updatedAt: maintenant
    };

    // Mettre à jour uniquement les champs non-null fournis
    if (type          !== undefined && type          !== null) donneesMaj.type          = type;
    if (statut        !== undefined && statut        !== null) donneesMaj.statut        = statut;
    if (details       !== undefined && details       !== null) donneesMaj.details       = details;
    if (transcription !== undefined && transcription !== null) donneesMaj.transcription = transcription;
    if (durationSec   !== undefined && durationSec   !== null) donneesMaj.durationSec   = durationSec;

    // Mettre à jour le client seulement si des infos ont été collectées
    if (client?.nom       ) donneesMaj['client.nom']       = client.nom;
    if (client?.telephone ) donneesMaj['client.telephone'] = client.telephone;

    await docRef.update(donneesMaj);
    console.log(`🔄 ia_orders mis à jour — callSid: ${callSid} | type: ${type} | statut: ${statut}`);

  } else {
    // Nouveau document → création complète
    const nouveauDoc = {
      callSid,
      vendeurId,
      type,
      statut,
      client: {
        nom:       client?.nom       || null,
        telephone: client?.telephone || null
      },
      details,
      transcription,
      durationSec,
      source:    'ia_vocal',
      createdAt: maintenant,
      updatedAt: maintenant
    };

    await docRef.set(nouveauDoc);
    console.log(`✅ ia_orders créé — callSid: ${callSid} | vendeurId: ${vendeurId} | type: ${type}`);
  }

  return docId;
}

/**
 * mettreAJourStatutAppel
 * Met à jour le document ia_orders correspondant à un CallSid.
 * Utilisé par :
 *   - POST /call/status (callback Twilio de fin d'appel)
 *   - Le WebSocket Media Stream (après réponse IA)
 *
 * @param {string} callSid — SID Twilio de l'appel à mettre à jour
 * @param {Object} data    — Champs à mettre à jour (statut, type, details, transcription, durationSec, etc.)
 * @returns {Promise<void>}
 */
async function mettreAJourStatutAppel(callSid, data = {}) {
  if (!callSid) {
    console.warn('mettreAJourStatutAppel : callSid manquant, mise à jour ignorée');
    return;
  }

  const db = _db();
  const docRef = db.collection('ia_orders').doc(callSid);

  try {
    const snap = await docRef.get();

    if (!snap.exists) {
      // Document inexistant (appel non enregistré initialement) → création minimale
      console.warn(`⚠️ ia_orders inexistant pour callSid: ${callSid} — création automatique`);
      await docRef.set({
        callSid,
        vendeurId:     data.vendeurId     || null,
        type:          data.type          || 'inconnu',
        statut:        data.statut        || 'inconnu',
        client:        data.client        || { nom: null, telephone: null },
        details:       data.details       || null,
        transcription: data.transcription || null,
        durationSec:   data.durationSec   || null,
        source:        'ia_vocal',
        createdAt:     admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:     admin.firestore.FieldValue.serverTimestamp()
      });
      return;
    }

    // Document existant → mise à jour des champs fournis
    const donneesMaj = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Copier tous les champs fournis dans data (sauf updatedAt déjà géré)
    const champsAutorisés = ['type', 'statut', 'details', 'transcription', 'durationSec', 'vendeurId'];
    for (const champ of champsAutorisés) {
      if (data[champ] !== undefined && data[champ] !== null) {
        donneesMaj[champ] = data[champ];
      }
    }

    // Champs client imbriqués
    if (data.client?.nom       ) donneesMaj['client.nom']       = data.client.nom;
    if (data.client?.telephone ) donneesMaj['client.telephone'] = data.client.telephone;

    await docRef.update(donneesMaj);
    console.log(`📊 ia_orders statut mis à jour — callSid: ${callSid} | statut: ${data.statut || '(inchangé)'}`);

  } catch (err) {
    console.error(`❌ mettreAJourStatutAppel erreur (callSid: ${callSid}) :`, err.message);
    throw err;
  }
}

module.exports = {
  ecrireIaOrder,
  mettreAJourStatutAppel
};
