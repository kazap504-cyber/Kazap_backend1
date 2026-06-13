/**
 * KAZAP — firestore-writer.js
 * Module d'écriture Firestore pour les commandes et RDV détectés par l'IA vocale.
 *
 * Collections utilisées :
 *   - ia_orders  : commandes / RDV / appels détectés par l'IA
 *
 * Fonctions exportées :
 *   - ecrireIaOrder(params)          → Crée ou met à jour un document ia_orders
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
