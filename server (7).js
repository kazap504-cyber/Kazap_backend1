/**
 * KAZAP — server.js
 * Backend principal : SMS, OTP, VoIP Twilio, FCM Push, IA Vocal (M-01)
 * Déployé sur : https://kazap-backend1.onrender.com
 *
 * Variables d'environnement requises sur Render :
 *   FIREBASE_ADMIN_KEY       → contenu JSON du compte de service Firebase (sur 1 ligne)
 *   FIREBASE_PROJECT_ID      → kazap-f8ff6
 *   BACKEND_URL              → https://kazap-backend1.onrender.com
 *   TWILIO_ACCOUNT_SID       → Account SID Twilio (AC...)
 *   TWILIO_AUTH_TOKEN        → Auth Token Twilio
 *   TWILIO_PHONE_NUMBER      → Numéro Twilio global E.164 (ex: +22961000000)
 *   TWILIO_API_KEY           → API Key SID (SK...)
 *   TWILIO_API_SECRET        → API Key Secret
 *   TWILIO_APP_SID           → TwiML App SID (AP...)
 *   DEEPGRAM_API_KEY         → Clé API Deepgram (STT)
 *   ANTHROPIC_API_KEY        → Clé API Anthropic (Claude)
 *   ADMIN_PHONE              → Numéro admin E.164 pour alertes downtime (T-07-C)
 *   FEDAPAY_WEBHOOK_SECRET   → Secret de signature webhook FedaPay (T-07-F)
 *                              Disponible dans dashboard.fedapay.com > Paramètres > Webhooks
 *   CLOUDINARY_CLOUD_NAME    → dhqtnuxii (nom du cloud Cloudinary)
 *   CLOUDINARY_API_KEY       → API Key Cloudinary (publique, mais générée côté dashboard)
 *   CLOUDINARY_API_SECRET    → API Secret Cloudinary — NE DOIT JAMAIS être exposé au client.
 *                              Utilisé uniquement ici pour signer les uploads (voir /api/cloudinary/sign).
 *   BREVO_API_KEY            → Clé API Brevo (dashboard Brevo > SMTP & API > API Keys) — requis pour /otp/send-email
 *   BREVO_SENDER_EMAIL       → Adresse expéditeur, DOIT être vérifiée dans Brevo (Senders, Domains & Dedicated IPs > Senders)
 *   BREVO_SENDER_NAME        → Nom affiché de l'expéditeur (optionnel, défaut : "KAZAP")
 *
 * NOTE (T-08) : l'envoi d'OTP par email utilise l'API HTTP de Brevo (https://api.brevo.com/v3/smtp/email)
 * et NON le SMTP classique. Render bloque le trafic sortant sur les ports SMTP (25/465/587) pour les
 * services sur plan gratuit depuis septembre 2025 — passer par une API HTTPS contourne cette restriction
 * sans nécessiter de passer sur un plan payant Render.
 *
 * ROUTES :
 *   POST /sms/send
 *   POST /otp/send
 *   POST /otp/send-email
 *   POST /otp/verify
 *   POST /otp/reset-password
 *   GET  /api/voip/token
 *   POST /api/voip/incoming-call
 *   POST /api/delete-account     ← T-DEL01-B Suppression definitive d'un compte vendeur
 *   POST /webhooks/twilio/:vendorId
 *   POST /webhooks/twilio/:vendorId/no-answer
 *   POST /webhooks/twilio/:vendorId/gather
 *   POST /webhooks/twilio/:vendorId/recording
 *   POST /api/save-fcm-token
 *   GET  /test-fcm/:vendorId
 *   POST /call/incoming          ← IA Vocal M-01
 *   POST /call/status            ← IA Vocal M-01
 *   GET  /api/ia_orders          ← IA Vocal M-01
 *   POST /api/voice/toggle       ← IA Vocal M-01
 *   POST /api/cloudinary/sign    ← Upload images signé (remplace l'unsigned preset)
 *   WS   /media-stream/:vendeurId ← IA Vocal M-01
 *   POST /uptime-alert           ← T-07-C Webhook downtime UptimeRobot → SMS admin
 *   POST /webhook/fedapay        ← T-07-F Webhook FedaPay → activation plan vendeur
 *   POST /api/invoices/generate  ← Fonctionnalité 1/3 : Facturation automatique (génère le PDF,
 *                                  l'archive sur Cloudinary, enregistre la facture Firestore, notifie
 *                                  le vendeur par email). Dépendance npm additionnelle : pdfkit.
 */

'use strict';

require('dotenv').config();

const express   = require('express');
const http      = require('http');
const crypto    = require('crypto');   // T-07-F — vérification HMAC FedaPay
const WebSocket = require('ws');
const twilio    = require('twilio');
const admin     = require('firebase-admin');
const cors      = require('cors');

// ─── Modules internes IA Vocal M-01 ─────────────────────────────────────────
const { traiterAudioStream, fermerDeepgram }    = require('./deepgram');
const { genererReponseIA, commandeEstComplete, genererReponseIAEcrit } = require('./claude-agent'); // Partie 2b/3 — messagerie écrite
const { ecrireIaOrder, mettreAJourStatutAppel } = require('./firestore-writer');
const { getCreneauxPourIA }                     = require('./agenda-reader'); // Agenda temps réel
const RdvBooking                                = require('./rdv-booking');     // Prise de RDV (M-04)
const paymentRouter                             = require('./payment');         // M-08 — Paiement Mobile Money
const PDFDocument                               = require('pdfkit');            // Fonctionnalité 1/3 — Facturation auto (npm install pdfkit)

// ─── M-10b.2 — i18n backend (voix Twilio TTS & Deepgram STT) ────────────────
const { getVoiceConfig, tpl } = require('./i18n.backend');

// ─── Firebase Admin ──────────────────────────────────────────────────────────
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_KEY);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId:  process.env.FIREBASE_PROJECT_ID || 'kazap-f8ff6'
  });
}
const db = admin.firestore();

// ─── Twilio ──────────────────────────────────────────────────────────────────
const twilioClient  = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const AccessToken   = twilio.jwt.AccessToken;
const VoiceGrant    = AccessToken.VoiceGrant;
const VoiceResponse = twilio.twiml.VoiceResponse;

// ─── Brevo (OTP par email) ──────────────────────────────────────────────────
// Envoi via l'API HTTP de Brevo (https://api.brevo.com/v3/smtp/email), PAS via
// SMTP : les services Render gratuits bloquent le trafic sortant sur les ports
// SMTP (25/465/587) depuis septembre 2025, donc Nodemailer/SMTP timeoutait
// systématiquement (ETIMEDOUT). L'API Brevo passe en HTTPS classique (port 443),
// jamais bloqué.
//
// _sendMailViaBrevo lève une erreur explicite si la config est absente ou si
// l'appel API échoue, pour que /otp/send-email réponde proprement (voir plus bas).
//
// Paramètre 'attachment' (optionnel, ajouté pour la Fonctionnalité 1/3 —
// Facturation automatique) : tableau au format Brevo, ex.
// [{ content: '<base64>', name: 'facture.pdf' }]. Non fourni par les appels
// existants (/otp/send-email) : leur comportement est inchangé.
async function _sendMailViaBrevo({ to, subject, text, html, attachment }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  if (!apiKey || !senderEmail) {
    throw new Error('BREVO_API_KEY / BREVO_SENDER_EMAIL non configurés sur le serveur.');
  }

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept':       'application/json',
      'content-type': 'application/json',
      'api-key':      apiKey
    },
    body: JSON.stringify({
      sender:      { email: senderEmail, name: process.env.BREVO_SENDER_NAME || 'KAZAP' },
      to:          [{ email: to }],
      subject,
      textContent: text,
      htmlContent: html,
      ...(attachment ? { attachment } : {})
    })
  });

  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch (_) { /* ignore */ }
    throw new Error(`Brevo API a répondu ${res.status} : ${detail}`);
  }
}

// ─── Express + HTTP server ───────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── M-08 — Paiement Mobile Money (FedaPay) ───────────────────────────────────
app.use('/api/payment', paymentRouter);

// === T-07-A : Health check endpoint (UptimeRobot / monitoring) ===============
app.get('/health', (req, res) => {
  res.status(200).json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    version:   '1.0.0'
  });
});
// === FIN T-07-A ==============================================================

// ─── Health check racine ───────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status:  'ok',
  service: 'kazap-backend',
  version: '2.0.0'
}));

// ════════════════════════════════════════════════════════════════════════════
// AUTO-PROVISIONING TWILIO — Appelé après inscription d'un nouveau vendeur
// POST /api/provision-number  { uid, email }
// ════════════════════════════════════════════════════════════════════════════
app.post('/api/provision-number', async (req, res) => {
  const { uid, email } = req.body;
  if (!uid) return res.status(400).json({ error: 'uid requis' });

  try {
    const numbers = await twilioClient.availablePhoneNumbers('US')
      .local.list({ limit: 1 });

    if (!numbers.length) {
      return res.status(500).json({ error: 'Aucun numéro disponible' });
    }

    const purchased = await twilioClient.incomingPhoneNumbers.create({
      phoneNumber: numbers[0].phoneNumber
    });

    // NB : on n'écrit plus createdAt ici — cette date doit rester figée à la
    // création réelle du compte (setDoc côté frontend, lors de l'inscription).
    // La réécrire à chaque provisionnement Twilio réussi décalait à tort la
    // date de référence utilisée pour calculer l'essai de 14 jours.
    await db.collection('vendors').doc(uid).set({
      twilioNumber: purchased.phoneNumber,
      email: email || null
    }, { merge: true });

    console.log(`✅ Numéro provisionné ${purchased.phoneNumber} pour ${uid}`);
    return res.json({ success: true, phoneNumber: purchased.phoneNumber });

  } catch (err) {
    console.error('[provision-number] Erreur :', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// SUPPRESSION DE COMPTE VENDEUR (T-DEL01-B)
// POST /api/delete-account  { uid }
// Necessite un token Firebase valide (Authorization: Bearer <idToken>)
// correspondant au uid cible. Supprime le document vendors/{uid}, les
// sous-ressources liees (produits, commandes, rendez-vous), puis le compte
// Firebase Authentication. Les suppressions Firestore sont effectuees avant
// la suppression du compte Auth : si une etape Firestore echoue, le compte
// Auth reste intact pour permettre une nouvelle tentative ou une investigation.
// ════════════════════════════════════════════════════════════════════════════

// Collections Firestore contenant des ressources rattachees a un vendeur,
// identifiees par un champ vendorId. A CONFIRMER avant mise en production :
// ces noms de collection/champ sont des valeurs par defaut, a aligner sur le
// schema Firestore reel utilise cote frontend pour les produits, commandes
// et rendez-vous.
const COLLECTIONS_LIEES_VENDEUR = [
  { nom: 'products',     champ: 'vendorId' },
  { nom: 'orders',       champ: 'vendorId' },
  { nom: 'appointments', champ: 'vendorId' }
];

async function supprimerDocumentsLiesVendeur(uid) {
  for (const { nom, champ } of COLLECTIONS_LIEES_VENDEUR) {
    const snap = await db.collection(nom).where(champ, '==', uid).get();
    if (snap.empty) continue;

    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 450) {
      const batch = db.batch();
      docs.slice(i, i + 450).forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    }
    console.log(`[delete-account] ${docs.length} document(s) supprime(s) dans "${nom}" pour uid=${uid}`);
  }
}

// ── T-DEL02 : liberation du numero Twilio Voice associe a un vendeur ────────
// Lit le numero (champ voip.number en priorite, puis twilioNumber en repli,
// meme logique que index.html ligne ~8339), retrouve son SID via l'API Twilio
// puis le libere. N'echoue jamais l'appelant : toute erreur est consignee
// (avec l'uid et le numero) pour permettre une liberation manuelle de secours,
// mais ne bloque pas la suite de la suppression du compte. Idempotent :
// l'absence de numero ou de correspondance cote Twilio est traitee comme un
// cas normal (deja libere ou jamais attribue).
async function libererNumeroTwilioVendeur(uid, vendorData) {
  const numero = vendorData?.voip?.number || vendorData?.twilioNumber;

  if (!numero) {
    console.log(`[delete-account][twilio] Aucun numero attribue pour uid=${uid}, etape ignoree`);
    return;
  }

  try {
    const correspondances = await twilioClient.incomingPhoneNumbers.list({
      phoneNumber: numero,
      limit: 1
    });

    if (!correspondances.length) {
      console.log(`[delete-account][twilio] Numero ${numero} (uid=${uid}) introuvable cote Twilio, deja libere ?`);
      return;
    }

    await twilioClient.incomingPhoneNumbers(correspondances[0].sid).remove();
    console.log(`[delete-account][twilio] Numero ${numero} (uid=${uid}) libere avec succes`);
  } catch (err) {
    console.error(`[delete-account][twilio] Echec liberation numero ${numero} (uid=${uid}) :`, err.message);
    // Non bloquant : la suppression du compte se poursuit malgre l'echec.
  }
}

app.post('/api/delete-account', async (req, res) => {
  const { uid } = req.body;
  if (!uid) return res.status(400).json({ error: 'uid requis' });

  // ── Verification du token Firebase (Authorization: Bearer <idToken>) ──────
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    return res.status(401).json({ error: 'Token d\'authentification manquant' });
  }

  let decodedToken;
  try {
    decodedToken = await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    console.error('[delete-account] Token invalide :', err.message);
    return res.status(401).json({ error: 'Token d\'authentification invalide' });
  }

  if (decodedToken.uid !== uid) {
    console.error(`[delete-account] uid du token (${decodedToken.uid}) different du uid demande (${uid})`);
    return res.status(403).json({ error: 'Non autorise a supprimer ce compte' });
  }

  // ── T-DEL02 : liberation du numero Twilio avant toute suppression de donnees,
  // pour ne jamais perdre l'information du numero a liberer en cas d'echec
  // partiel du processus. Lecture seule, ne peut pas faire echouer la suite.
  try {
    const vendorSnap = await db.collection('vendors').doc(uid).get();
    if (vendorSnap.exists) {
      await libererNumeroTwilioVendeur(uid, vendorSnap.data());
    } else {
      console.log(`[delete-account][twilio] Document vendors/${uid} introuvable, etape Twilio ignoree`);
    }
  } catch (err) {
    console.error(`[delete-account][twilio] Erreur lecture vendors/${uid} :`, err.message);
    // Non bloquant : on tente quand meme la suppression du compte.
  }

  // ── Suppressions Firestore (avant suppression du compte Auth) ─────────────
  try {
    await supprimerDocumentsLiesVendeur(uid);
    await db.collection('vendors').doc(uid).delete();
    console.log(`[delete-account] Document vendors/${uid} supprime`);
  } catch (err) {
    console.error('[delete-account] Erreur suppression Firestore :', err.message);
    return res.status(500).json({
      error: 'Erreur lors de la suppression des donnees. Le compte n\'a pas ete supprime.'
    });
  }

  // ── Suppression du compte Firebase Authentication ─────────────────────────
  try {
    await admin.auth().deleteUser(uid);
    console.log(`[delete-account] Compte Auth ${uid} supprime`);
  } catch (err) {
    console.error('[delete-account] Erreur suppression compte Auth :', err.message);
    return res.status(500).json({
      error: 'Les donnees ont ete supprimees mais le compte d\'authentification n\'a pas pu etre supprime. Contactez le support.'
    });
  }

  console.log(`[delete-account] Suppression complete du compte vendeur ${uid}`);
  return res.status(200).json({ success: true });
});

// ════════════════════════════════════════════════════════════════════════════
// HELPERS — Notifications SMS commande IA
// ════════════════════════════════════════════════════════════════════════════

/**
 * _notifierCommandeIA
 * Envoie un SMS de confirmation au client ET une notification au vendeur
 * après qu'une commande IA a été confirmée et écrite en Firestore.
 *
 * @param {Object} params
 * @param {string} params.vendeurId
 * @param {Object} params.vendeurData
 * @param {string} params.ordreId       — ID de la commande (ex: IA-XXXXX)
 * @param {Object} params.details       — Champs extraits par Claude
 * @param {string} params.clientPhone   — Numéro du client (From Twilio)
 */
async function _notifierCommandeIA({ vendeurId, vendeurData, ordreId, details, clientPhone }) {
  const boutique    = vendeurData?.boutiqueName || 'la boutique';
  const fromNumber  = vendeurData?.voip?.twilioPhoneNumber
                   || vendeurData?.voip?.number
                   || process.env.TWILIO_PHONE_NUMBER;

  if (!fromNumber) {
    console.warn('[SMS Commande IA] Numéro Twilio non configuré, SMS ignoré');
    return;
  }

  const total = Number(details?.total || 0).toLocaleString('fr-FR');

  // SMS client
  if (clientPhone && clientPhone !== 'unknown') {
    try {
      await twilioClient.messages.create({
        body: `✅ KAZAP | Commande ${ordreId} confirmée chez ${boutique}.\nTotal : ${total} FCFA.\nMerci pour votre achat !`,
        from: fromNumber,
        to:   clientPhone
      });
      console.log(`✅ SMS confirmation envoyé au client → ${clientPhone}`);
    } catch (err) {
      console.error('[SMS client] Erreur :', err.message);
    }
  }

  // SMS vendeur
  const vendeurPhone = vendeurData?.phone || vendeurData?.voip?.twilioForwardNumber;
  if (vendeurPhone) {
    try {
      await twilioClient.messages.create({
        body: `🛒 KAZAP | Nouvelle commande ${ordreId} !\nClient : ${details?.clientNom || 'Client appel'} (${clientPhone || '—'})\nProduit : ${details?.produit} ×${details?.quantite}\nAdresse : ${details?.adresse || '—'}\nTotal : ${total} FCFA\nConnectez-vous sur KAZAP pour traiter.`,
        from: fromNumber,
        to:   vendeurPhone
      });
      console.log(`✅ SMS notification envoyé au vendeur → ${vendeurPhone}`);
    } catch (err) {
      console.error('[SMS vendeur] Erreur :', err.message);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// GATING PLAN / ESSAI / QUOTA IA — miroir serveur des vérifications client
// (kazapP10_hasFeature('ia'), kazapP11_checkIAQuota, kazapP12_isTrialActive
// dans index.html). Autorité finale avant d'ouvrir un flux IA vocal coûteux
// (Twilio + Deepgram + Claude) ou d'envoyer un SMS — le toggle côté dashboard
// ne suffit pas, il faut aussi vérifier le plan et le quota du vendeur.
// ════════════════════════════════════════════════════════════════════════════

/** Limite mensuelle de minutes d'appel IA par plan. Doit rester synchronisée
 *  avec window.kazapP11_IA_CALL_LIMITS dans index.html. */
const KAZAP_IA_CALL_LIMITS = { basique: 0, pro: 60, premium: Infinity, trial: 0, free: 0 };

/** Reproduit kazapP8_normalizePlan (index.html) : migration douce du champ plan. */
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

/** Reproduit kazapP12_isTrialActive (index.html) : essai de 14 jours depuis
 *  planActivatedAt (ou createdAt en repli). Sans date connue → permissif,
 *  comme côté client, pour ne jamais verrouiller un compte par erreur. */
function _essaiEncoreActif(vendeurData) {
  const plan = _normaliserPlan(vendeurData);
  if (plan !== 'trial' && plan !== 'free') return false;
  const refMs = _tsEnMs(vendeurData?.planActivatedAt) || _tsEnMs(vendeurData?.createdAt);
  if (!refMs) return true;
  return Date.now() < refMs + 14 * 86400000;
}

/** Reproduit kazapP8_isPlanActive (index.html, Partie 8/2 client) : les plans
 *  trial/free délèguent à _essaiEncoreActif (kazapP12_isTrialActive) ; les
 *  plans payants (basique/pro/premium) sont actifs tant que planExpiresAt
 *  n'est pas dépassé. Sans date d'expiration connue → permissif (comme côté
 *  client), plutôt que de bloquer un compte par erreur. */
function _planEstActif(vendeurData) {
  const plan = _normaliserPlan(vendeurData);
  if (plan === 'trial' || plan === 'free') return _essaiEncoreActif(vendeurData);
  const expMs = _tsEnMs(vendeurData?.planExpiresAt);
  if (!expMs) return true; // pas encore d'expiration connue
  return expMs >= Date.now();
}

/** Reproduit kazapP13_isCompteBloque (index.html, Partie 13/2 client) : miroir
 *  exact du verrou global côté client (Document 2/8 puis 3/8). Un compte est
 *  "bloqué" dès que son plan n'est plus actif au sens de _planEstActif — essai
 *  terminé sans souscription (trial/free), OU abonnement payant (Basique/Pro/
 *  Premium) arrivé à échéance sans renouvellement. Ne réimplémente aucun
 *  calcul de date : délègue entièrement à _planEstActif, elle-même adossée à
 *  _essaiEncoreActif et à planExpiresAt — mêmes sources de vérité que côté
 *  client, jamais recalculées autrement. C'est l'autorité serveur finale :
 *  un client qui modifie le code de la page ne peut jamais la contourner. */
function _compteEstBloque(vendeurData) {
  return !_planEstActif(vendeurData);
}

/**
 * verifierCompteActif — middleware Express réutilisable (Partie 3/8).
 * Miroir serveur du verrou global côté client (kazapP13_isCompteBloque /
 * showDashSection dans index.html) : à poser sur toute route sensible qui ne
 * concerne pas Accueil/Abonnement/Paramètres, pour empêcher un client dont le
 * code a été altéré dans le navigateur de contourner le blocage.
 *
 * Résout le vendorId depuis req.params.vendorId, ou à défaut req.body.vendorId
 * / req.body.vendorUid (selon la convention de la route ciblée). Charge le
 * document vendeur Firestore et renvoie 403 si _compteEstBloque() est vrai.
 * En cas d'erreur technique (Firestore indisponible, etc.), reste permissif
 * et laisse la route gérer elle-même ses propres vérifications, plutôt que
 * de bloquer un client légitime sur un incident serveur transitoire.
 *
 * Le vendeur chargé est exposé sur req.vendeurData, pour éviter une seconde
 * lecture Firestore dans le handler de la route.
 *
 * Usage :
 *   app.post('/sms/send', verifierCompteActif, async (req, res) => { ... });
 */
async function verifierCompteActif(req, res, next) {
  try {
    const vendorId = req.params?.vendorId || req.body?.vendorId || req.body?.vendorUid;
    if (!vendorId) {
      // Aucun identifiant vendeur exploitable ici : ce n'est pas à ce
      // middleware de renvoyer une erreur de validation générique — la route
      // elle-même vérifie déjà ses paramètres requis.
      return next();
    }
    const vendorSnap = await db.collection('vendors').doc(vendorId).get();
    if (!vendorSnap.exists) {
      return res.status(404).json({ error: 'Vendor introuvable' });
    }
    const vendeurData = vendorSnap.data();
    if (_compteEstBloque(vendeurData)) {
      console.warn(`[Verrou global] vendorId=${vendorId} — accès refusé (compte bloqué, verifierCompteActif).`);
      return res.status(403).json({
        error: "Votre essai gratuit ou votre abonnement est arrivé à échéance. Rendez-vous sur la section Abonnement pour continuer à utiliser cette fonctionnalité."
      });
    }
    req.vendeurData = vendeurData;
    return next();
  } catch (err) {
    console.error('[verifierCompteActif] Erreur :', err.message);
    return next();
  }
}

/** Reproduit kazapP10_hasFeature('ia'/'agenda'/'sms', plan) + le patch d'essai
 *  (Partie 12) : Pro/Premium → accès. Essai actif (trial/free dans les 14
 *  jours) → accès Premium complet. Basique, ou essai expiré → pas d'accès.
 *  La logique ne dépend pas de la fonctionnalité, seulement du plan/essai —
 *  valable pour l'IA vocale ET pour le SMS (kazapP10_hasFeature applique la
 *  même règle aux deux).
 *  [Partie 3/8] Vérifie d'abord _compteEstBloque : un plan 'pro'/'premium'
 *  dont planExpiresAt est dépassé ne doit plus jamais donner accès, même si
 *  le champ 'plan' Firestore affiche encore 'pro'/'premium' (le champ n'est
 *  mis à jour qu'au moment d'un nouveau paiement, pas automatiquement à
 *  l'expiration). C'est la faille corrigée par cette partie : auparavant
 *  cette fonction ne vérifiait jamais planExpiresAt pour les plans payants. */
function _accesIAAutorise(vendeurData) {
  if (_compteEstBloque(vendeurData)) return false;
  if (_essaiEncoreActif(vendeurData)) return true;
  const plan = _normaliserPlan(vendeurData);
  return plan === 'pro' || plan === 'premium';
}

/** Additif Partie 6/8 — factorise la lecture Firestore commune à
 *  _quotaIADisponible (contrôle AVANT de démarrer un appel) et à
 *  _quotaIADepasseEnCours (contrôle PENDANT un appel déjà en cours) : somme,
 *  en minutes, les durées (durationSec) de tous les ia_orders du vendeur
 *  depuis le début du mois civil en cours. */
async function _minutesIAUtiliseesMoisCourant(vendeurId) {
  const debutMois = new Date();
  debutMois.setDate(1);
  debutMois.setHours(0, 0, 0, 0);

  const snap = await db.collection('ia_orders')
    .where('vendeurId', '==', vendeurId)
    .where('createdAt', '>=', debutMois)
    .get();

  let totalSec = 0;
  snap.forEach(doc => { totalSec += Number(doc.data()?.durationSec || 0); });
  return totalSec / 60;
}

/** Reproduit kazapP11_checkIAQuota + le patch d'essai : vérifie, à partir des
 *  ia_orders Firestore du mois courant (seule source fiable côté serveur),
 *  que le vendeur n'a pas dépassé son quota de minutes IA. Essai actif ou
 *  Premium → toujours true. En cas d'erreur technique de lecture, on reste
 *  permissif plutôt que de bloquer un client légitime.
 *  [Partie 3/8] Vérifie d'abord _compteEstBloque, pour la même raison que
 *  _accesIAAutorise : un plan Pro/Premium expiré ne doit plus donner de
 *  quota IA, même si le champ 'plan' n'a pas encore été mis à jour. */
async function _quotaIADisponible(vendeurId, vendeurData) {
  if (_compteEstBloque(vendeurData)) return false;
  if (_essaiEncoreActif(vendeurData)) return true;
  const plan   = _normaliserPlan(vendeurData);
  const limite = KAZAP_IA_CALL_LIMITS[plan] ?? 0;
  if (limite === Infinity) return true;
  if (limite <= 0) return false;

  try {
    const minutesUtilisees = Math.ceil(await _minutesIAUtiliseesMoisCourant(vendeurId));
    return minutesUtilisees < limite;
  } catch (err) {
    console.error('[Quota IA] Erreur lecture ia_orders :', err.message);
    return true;
  }
}

/**
 * _quotaIADepasseEnCours — Partie 6/8.
 * Variante de _quotaIADisponible destinée au contrôle PÉRIODIQUE pendant un
 * appel déjà en cours (toutes les ~30s, depuis le WebSocket media-stream).
 *
 * Différence clé : l'appel en cours n'a pas encore de durationSec connu côté
 * Firestore (il n'est écrit qu'à la fin par /call/status), donc
 * _minutesIAUtiliseesMoisCourant() ne "voit" que les appels déjà terminés ce
 * mois-ci. On ajoute donc ici la durée déjà écoulée de l'appel EN COURS
 * (elapsedSec, mesurée côté serveur depuis l'évènement Twilio "start"), pour
 * ne jamais dépasser la limite de façon perceptible pour l'appelant.
 *
 * @param {string} vendeurId
 * @param {object} vendeurData
 * @param {number} elapsedSec — secondes déjà écoulées sur l'appel en cours
 * @returns {Promise<boolean>} true si la limite est (ou vient d'être) dépassée
 *   → l'appelant doit être coupé. Essai actif / Premium (illimité) → toujours
 *   false. En cas d'erreur technique, reste permissif (false) plutôt que de
 *   couper un appel légitime sur un incident Firestore transitoire.
 */
async function _quotaIADepasseEnCours(vendeurId, vendeurData, elapsedSec) {
  if (_compteEstBloque(vendeurData)) return true;
  if (_essaiEncoreActif(vendeurData)) return false;
  const plan   = _normaliserPlan(vendeurData);
  const limite = KAZAP_IA_CALL_LIMITS[plan] ?? 0;
  if (limite === Infinity) return false;
  if (limite <= 0) return true;

  try {
    const minutesAvant = await _minutesIAUtiliseesMoisCourant(vendeurId);
    const minutesTotal = minutesAvant + (Number(elapsedSec) || 0) / 60;
    return minutesTotal >= limite;
  } catch (err) {
    console.error('[Quota IA en cours] Erreur lecture ia_orders :', err.message);
    return false;
  }
}
// === FIN GATING PLAN / ESSAI / QUOTA IA ======================================

// ════════════════════════════════════════════════════════════════════════════
// CLOUDINARY — Upload signé (remplace l'upload_preset non signé côté client)
// ════════════════════════════════════════════════════════════════════════════
// Le client demande une signature ici avant chaque upload. Le dossier cible
// est reconstruit ici, côté serveur, à partir du vendorId reçu (jamais accepté
// tel quel depuis le client) — impossible d'écrire ailleurs que dans
// kazap/vendors/{vendorId}/... Le secret Cloudinary ne quitte jamais ce fichier.
app.post('/api/cloudinary/sign', async (req, res) => {
  const { vendorId, sousDossier } = req.body;
  if (!vendorId) return res.status(400).json({ error: 'vendorId requis' });
  if (!process.env.CLOUDINARY_API_SECRET || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_CLOUD_NAME) {
    console.error('[Cloudinary Sign] Variables d\'environnement Cloudinary manquantes.');
    return res.status(500).json({ error: 'Configuration Cloudinary manquante côté serveur' });
  }
  try {
    // Sous-dossier limité à une liste connue pour éviter toute injection
    // de chemin (ex. "../../autre-vendeur") — 'products' par défaut.
    const sousDossiersAutorises = ['products', 'shop', 'profile'];
    const dossier = sousDossiersAutorises.includes(sousDossier) ? sousDossier : 'products';
    const folder  = `kazap/vendors/${vendorId}/${dossier}`;

    const timestamp = Math.floor(Date.now() / 1000);
    // Cloudinary : signature = sha1("param1=valeur1&param2=valeur2..." + api_secret)
    // Les paramètres doivent être triés par ordre alphabétique de clé.
    const paramsASigner = { folder, timestamp };
    const chaineASigner = Object.keys(paramsASigner)
      .sort()
      .map(k => `${k}=${paramsASigner[k]}`)
      .join('&');
    const signature = crypto
      .createHash('sha1')
      .update(chaineASigner + process.env.CLOUDINARY_API_SECRET)
      .digest('hex');

    return res.json({
      signature,
      timestamp,
      apiKey:    process.env.CLOUDINARY_API_KEY,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      folder
    });
  } catch (err) {
    console.error('[Cloudinary Sign] Erreur :', err);
    return res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// FACTURATION AUTOMATIQUE (Fonctionnalité 1/3) — voir note technique PDF
// ════════════════════════════════════════════════════════════════════════════
// Adaptations par rapport à la note technique, pour coller au schéma réel déjà
// en place côté KAZAP (rien n'est modifié dans orders/vendors, on lit juste ce
// qui existe) :
//  - Une commande KAZAP = UN SEUL produit (productName / productPrice /
//    quantity / total), pas de tableau 'items' à la création. On construit
//    un tableau à une entrée pour rester compatible avec le schéma de la
//    collection 'invoices' déjà consommé par renderInvoices() côté frontend.
//  - Le montant de la commande est stocké dans 'total' (pas 'totalAmount') ;
//    la facture, elle, garde bien le champ 'totalAmount' attendu par le
//    frontend (index.html, renderInvoices()).
//  - Aucun champ 'clientEmail' n'existe sur les commandes (le formulaire
//    client ne demande que nom / téléphone / adresse). L'envoi automatique
//    par email se fait donc vers l'email du VENDEUR (notification + archive
//    avec le PDF en pièce jointe) plutôt que vers le client. La distribution
//    au client reste couverte par le bouton "WhatsApp" déjà câblé dans
//    l'onglet Factures (lien wa.me + téléchargement du PDF Cloudinary).
//  - Upload Cloudinary fait à la main via fetch + signature HMAC (même
//    principe que /api/cloudinary/sign ci-dessus), pour ne pas ajouter la
//    dépendance npm 'cloudinary' en plus de 'pdfkit'.

// ─── Numérotation unique auto-incrémentée (transaction Firestore) ───────────
async function generateNextInvoiceNumber() {
  const ref = db.collection('counters').doc('invoices');
  const number = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? (snap.data().lastNumber || 0) : 0;
    const next = current + 1;
    tx.set(ref, { lastNumber: next, year: new Date().getFullYear() }, { merge: true });
    return next;
  });
  return `KZP-${new Date().getFullYear()}-${String(number).padStart(6, '0')}`;
}

// ─── Génération du PDF (PDFKit, en mémoire — pas d'écriture disque) ─────────
// CORRECTIF — Number.toLocaleString('fr-FR') insère une espace fine insécable
// (U+202F) comme séparateur de milliers. Ce caractère n'existe pas dans la
// police standard Helvetica utilisée par PDFKit (encodage WinAnsi), qui le
// remplaçait par un glyphe de substitution ressemblant à un "/" (ex: "7 /000").
// formatMontantPdf() utilise une espace normale (toujours supportée), pour un
// affichage correct des montants dans le PDF uniquement (SMS/email non touchés).
function formatMontantPdf(n) {
  return Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// ─── Détail des articles d'une commande ─────────────────────────────────────
// Certaines commandes KAZAP contiennent plusieurs produits (order.items[]),
// d'autres suivent encore l'ancien schéma mono-produit (productName /
// productPrice / quantity). On centralise ici la logique de dérivation pour
// que la facture Firestore ET le PDF utilisent exactement la même liste.
function buildInvoiceItems(order) {
  if (Array.isArray(order.items) && order.items.length) {
    return order.items.map((it) => ({
      name:  it.name  || 'Produit',
      qty:   it.qty ?? it.quantity ?? 1,
      price: it.price ?? it.productPrice ?? 0
    }));
  }
  return [{
    name:  order.productName  || 'Produit',
    qty:   order.quantity     || 1,
    price: order.productPrice || 0
  }];
}

function buildInvoicePdfBuffer({ order, vendor, invoiceNumber }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const PAGE_LEFT  = 50;
      const PAGE_RIGHT = doc.page.width - 50;
      const DARK   = '#1A1A1A';
      const GREY   = '#6B7280';
      const LIGHT  = '#9CA3AF';
      const ACCENT = '#AD7A2C';
      const LINE   = '#E5E7EB';

      // ── En-tête : boutique à gauche / n° facture + date + vendeur à droite ──
      // (pas de logo KAZAP, cf. note technique §6 — pas d'email boutique affiché)
      const headerTop = doc.y;

      doc.font('Helvetica-Bold').fontSize(16).fillColor(DARK)
        .text(vendor.boutiqueName || 'Boutique', PAGE_LEFT, headerTop, { width: 260 });
      if (vendor.phone) {
        doc.font('Helvetica').fontSize(9).fillColor(GREY)
          .text(`Tél : ${vendor.phone}`, PAGE_LEFT, doc.y + 4, { width: 260 });
      }

      doc.font('Helvetica-Bold').fontSize(14).fillColor(ACCENT)
        .text(invoiceNumber, PAGE_LEFT, headerTop, { width: PAGE_RIGHT - PAGE_LEFT, align: 'right' });
      doc.font('Helvetica').fontSize(9).fillColor(GREY)
        .text(`Date : ${new Date().toLocaleDateString('fr-FR')}`, PAGE_LEFT, doc.y + 4, { width: PAGE_RIGHT - PAGE_LEFT, align: 'right' });
      if (vendor.prenom) {
        doc.text(`Vendeur : ${vendor.prenom}`, PAGE_LEFT, doc.y, { width: PAGE_RIGHT - PAGE_LEFT, align: 'right' });
      }

      doc.y = Math.max(doc.y, headerTop + 60);
      doc.moveDown(2);

      // ── Facturé à ──
      doc.font('Helvetica').fontSize(8).fillColor(LIGHT)
        .text('FACTURÉ À', PAGE_LEFT, doc.y, { characterSpacing: 0.5 });
      doc.font('Helvetica-Bold').fontSize(11).fillColor(DARK)
        .text(order.clientName || '', PAGE_LEFT, doc.y + 4);
      if (order.clientPhone) {
        doc.font('Helvetica').fontSize(9).fillColor(GREY)
          .text(order.clientPhone, PAGE_LEFT, doc.y + 2);
      }
      doc.moveDown(2);

      // ── Tableau des articles ──
      // Une ligne par produit : order.items[] si la commande est multi-produits,
      // sinon repli sur le produit unique de l'ancien schéma (buildInvoiceItems).
      const items = buildInvoiceItems(order);

      const colArticle   = PAGE_LEFT;
      const colRef       = 250;
      const colPrice     = 330;
      const colQty       = 430;
      const colSubtotal  = 470;

      const tableTop = doc.y;
      doc.font('Helvetica').fontSize(8).fillColor(LIGHT);
      doc.text('ARTICLE',    colArticle,  tableTop, { characterSpacing: 0.4 });
      doc.text('RÉF',        colRef,      tableTop, { characterSpacing: 0.4 });
      doc.text('PRIX UNIT.', colPrice,    tableTop, { characterSpacing: 0.4 });
      doc.text('QTÉ',        colQty,      tableTop, { characterSpacing: 0.4 });
      doc.text('SOUS-TOTAL', colSubtotal, tableTop, { width: PAGE_RIGHT - colSubtotal, align: 'right', characterSpacing: 0.4 });

      doc.moveTo(PAGE_LEFT, tableTop + 16).lineTo(PAGE_RIGHT, tableTop + 16)
        .strokeColor(LINE).lineWidth(1).stroke();

      let rowY = tableTop + 26;
      items.forEach((it, idx) => {
        const qty      = Number(it.qty) || 0;
        const price    = Number(it.price) || 0;
        const subtotal = qty * price;
        // Pas de SKU réel dans le schéma produit actuel : référence générée
        // automatiquement selon l'ordre d'affichage dans la facture.
        const ref = `Art-${String(idx + 1).padStart(3, '0')}`;

        doc.font('Helvetica').fontSize(10).fillColor(DARK)
          .text(it.name, colArticle, rowY, { width: colRef - colArticle - 10 });
        doc.font('Helvetica').fontSize(9).fillColor(GREY)
          .text(ref, colRef, rowY, { width: colPrice - colRef - 10 })
          .text(`${formatMontantPdf(price)} FCFA`, colPrice, rowY, { width: colQty - colPrice - 5 })
          .text(String(qty), colQty, rowY, { width: colSubtotal - colQty - 5 });
        doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK)
          .text(`${formatMontantPdf(subtotal)} FCFA`, colSubtotal, rowY, { width: PAGE_RIGHT - colSubtotal, align: 'right' });

        rowY += 24;
      });

      doc.y = rowY + 6;

      // ── Total ──
      doc.moveTo(PAGE_LEFT, doc.y).lineTo(PAGE_RIGHT, doc.y).strokeColor(LINE).lineWidth(1).stroke();
      doc.moveDown(1);

      const totalY = doc.y;
      doc.font('Helvetica-Bold').fontSize(11).fillColor(ACCENT)
        .text('TOTAL', colQty, totalY, { width: colSubtotal - colQty - 5 });
      doc.font('Helvetica-Bold').fontSize(13).fillColor(DARK)
        .text(`${formatMontantPdf(order.total)} FCFA`, colRef, totalY, { width: PAGE_RIGHT - colRef, align: 'right' });

      doc.moveDown(3);

      // ── Mention légale (inchangée) ──
      doc.font('Helvetica').fontSize(8).fillColor(LIGHT).text(
        'Tout paiement effectué est définitif et non remboursable, sauf accord écrit préalable du vendeur.',
        PAGE_LEFT,
        doc.y,
        { width: PAGE_RIGHT - PAGE_LEFT, align: 'center' }
      );

      doc.moveDown(1.5);
      doc.moveTo(PAGE_LEFT, doc.y).lineTo(PAGE_RIGHT, doc.y).strokeColor(LINE).lineWidth(1).stroke();

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ─── Upload du PDF sur Cloudinary (resource_type: raw, upload signé à la main) ──
async function uploadInvoiceToCloudinary(buffer, invoiceNumber) {
  if (!process.env.CLOUDINARY_API_SECRET || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_CLOUD_NAME) {
    throw new Error('Configuration Cloudinary manquante côté serveur');
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = 'kazap/invoices';
  const paramsASigner = { folder, public_id: invoiceNumber, timestamp };
  const chaineASigner = Object.keys(paramsASigner)
    .sort()
    .map((k) => `${k}=${paramsASigner[k]}`)
    .join('&');
  const signature = crypto
    .createHash('sha1')
    .update(chaineASigner + process.env.CLOUDINARY_API_SECRET)
    .digest('hex');

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/pdf' }), `${invoiceNumber}.pdf`);
  form.append('api_key', process.env.CLOUDINARY_API_KEY);
  form.append('timestamp', String(timestamp));
  form.append('signature', signature);
  form.append('folder', folder);
  form.append('public_id', invoiceNumber);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/raw/upload`, {
    method: 'POST',
    body: form
  });
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch (_) { /* ignore */ }
    throw new Error(`Cloudinary a répondu ${res.status} : ${detail}`);
  }
  return res.json();
}

// ─── Envoi automatique (notification vendeur + PDF en pièce jointe, via Brevo) ──
async function sendInvoiceByEmail({ order, vendor, invoiceNumber, pdfBuffer }) {
  if (!vendor.email) return; // pas d'email vendeur enregistré → pas d'envoi, la facture reste consultable dans le dashboard
  await _sendMailViaBrevo({
    to:      vendor.email,
    subject: `Facture ${invoiceNumber} — Commande ${order.orderId || ''}`,
    text:    `Facture ${invoiceNumber} générée pour la commande de ${order.clientName || 'un client'} (${Number(order.total || 0).toLocaleString('fr-FR')} FCFA). PDF en pièce jointe.`,
    html:    `<p>Facture <strong>${invoiceNumber}</strong> générée pour la commande de <strong>${order.clientName || 'un client'}</strong>.</p><p>Total : ${Number(order.total || 0).toLocaleString('fr-FR')} FCFA</p>`,
    attachment: [{ content: pdfBuffer.toString('base64'), name: `${invoiceNumber}.pdf` }]
  });
}

// ─── Endpoint principal ──────────────────────────────────────────────────────
// POST /api/invoices/generate  { orderId, vendorId }
// Appelé en fire-and-forget depuis updateOrderStatusFirebase (index.html) dès
// qu'une commande passe au statut 'delivered'. Ne doit jamais faire échouer la
// mise à jour de statut côté client : l'appelant frontend a son propre
// try/catch silencieux, et ici toute erreur est encapsulée et journalisée.
app.post('/api/invoices/generate', verifierCompteActif, async (req, res) => {
  const { orderId, vendorId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'orderId requis' });

  try {
    // CORRECTIF ANTI-DOUBLON — une commande ne doit générer qu'une seule facture.
    // Si le statut "Livrée" est resélectionné (ex. clic répété sur le menu déroulant,
    // ou nouvel appel après un échec réseau côté client déjà réussi côté serveur), on
    // renvoie la facture existante au lieu d'en recréer une (évite un doublon Cloudinary
    // + Firestore + un second email au client).
    const existingSnap = await db.collection('invoices').where('orderId', '==', orderId).limit(1).get();
    if (!existingSnap.empty) {
      const existing = existingSnap.docs[0];
      return res.json({ success: true, invoiceId: existing.id, invoiceNumber: existing.data().invoiceNumber, pdfUrl: existing.data().pdfUrl, alreadyExisted: true });
    }

    const orderSnap = await db.collection('orders').doc(orderId).get();
    if (!orderSnap.exists) return res.status(404).json({ error: 'Commande introuvable' });
    const order = orderSnap.data();

    const effectiveVendorId = order.vendorId || vendorId;
    const vendorSnap = effectiveVendorId ? await db.collection('vendors').doc(effectiveVendorId).get() : null;
    const vendor = (vendorSnap && vendorSnap.exists) ? vendorSnap.data() : {};

    const invoiceNumber = await generateNextInvoiceNumber();
    const pdfBuffer      = await buildInvoicePdfBuffer({ order, vendor, invoiceNumber });
    const uploadResult   = await uploadInvoiceToCloudinary(pdfBuffer, invoiceNumber);

    const invoiceRef = await db.collection('invoices').add({
      invoiceNumber,
      orderId,
      orderRef:    order.orderId || orderId,
      vendorId:    effectiveVendorId || null,
      vendorName:  vendor.boutiqueName || '',
      clientName:  order.clientName  || '',
      clientPhone: order.clientPhone || '',
      items:       buildInvoiceItems(order),
      totalAmount: order.total || 0,
      pdfUrl:      uploadResult.secure_url,
      status:      'generated',
      createdAt:   admin.firestore.FieldValue.serverTimestamp()
    });

    // Envoi email non bloquant : la facture reste "generated" (donc visible et
    // téléchargeable) même si l'email échoue ; elle passe à "sent" si l'email part.
    sendInvoiceByEmail({ order, vendor, invoiceNumber, pdfBuffer })
      .then((sent) => { if (vendor.email) invoiceRef.update({ status: 'sent' }).catch(() => {}); })
      .catch((mailErr) => {
        console.warn('[Factures] Email non envoyé (facture générée quand même) :', mailErr.message);
      });

    return res.json({ success: true, invoiceId: invoiceRef.id, invoiceNumber, pdfUrl: uploadResult.secure_url });
  } catch (err) {
    console.error('[Factures] Erreur génération facture :', err);
    return res.status(500).json({ error: err.message });
  }
});
// ════════════════════════════════════════════════════════════════════════════
// FIN FACTURATION AUTOMATIQUE
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// SMS — Envoi de messages
// ════════════════════════════════════════════════════════════════════════════
app.post('/sms/send', verifierCompteActif, async (req, res) => {
  const { vendorId, to, message } = req.body;
  if (!vendorId || !to || !message) {
    return res.status(400).json({ error: 'vendorId, to et message sont requis' });
  }
  try {
    // req.vendeurData est déjà chargé par verifierCompteActif (Partie 3/8) si
    // vendorId était présent ; on ne relit Firestore que si, pour une raison
    // quelconque, ce n'est pas le cas (ex. middleware court-circuité en test).
    const vendor = req.vendeurData || (await db.collection('vendors').doc(vendorId).get()).data();
    if (!vendor) return res.status(404).json({ error: 'Vendor introuvable' });

    // ── Gating plan (miroir serveur de kazapP10_hasFeature('sms', plan)) ──
    // Couvre à la fois "compte bloqué" (déjà filtré en amont par le
    // middleware, revérifié ici par sécurité) et "fonctionnalité non incluse
    // dans le plan actif" (ex. Basique, où SMS n'est de toute façon jamais
    // inclus, même compte non bloqué).
    if (!_accesIAAutorise(vendor)) {
      console.warn(`[Gating SMS] vendorId=${vendorId} — plan insuffisant ou compte bloqué pour l'envoi de SMS.`);
      return res.status(403).json({ error: 'Fonctionnalité SMS non disponible pour votre plan.' });
    }

    const fromNumber = vendor?.voip?.twilioPhoneNumber || process.env.TWILIO_PHONE_NUMBER;
    if (!fromNumber) return res.status(400).json({ error: 'Numéro Twilio non configuré' });

    const result = await twilioClient.messages.create({ body: message, from: fromNumber, to });
    return res.json({ success: true, sid: result.sid });
  } catch (err) {
    console.error('[SMS Send] Erreur :', err);
    return res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// OTP — Envoi et vérification (stockage Firestore)
// ════════════════════════════════════════════════════════════════════════════
app.post('/otp/send', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Numéro requis' });

  const code      = String(Math.floor(1000 + Math.random() * 9000));
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const key       = 'otp_' + phone.replace(/\D/g, '');

  try {
    await db.collection('otp_codes').doc(key).set({
      code, expiresAt, phone,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await twilioClient.messages.create({
      body: `Votre code KAZAP : ${code} (valable 10 min)`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to:   phone
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('[OTP Send] Erreur :', err);
    return res.status(500).json({ error: 'Erreur envoi OTP : ' + err.message });
  }
});

// ─── OTP par email — envoi via SMTP au lieu du SMS Twilio ───────────────────
// Réutilise la même collection Firestore 'otp_codes' que /otp/send, avec une
// clé préfixée 'otp_email_' pour ne jamais entrer en collision avec les clés
// 'otp_' basées sur un numéro de téléphone.
app.post('/otp/send-email', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requis' });

  const emailNorm = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
    return res.status(400).json({ error: 'Email invalide' });
  }

  if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) {
    console.error('[OTP Send Email] Configuration Brevo manquante (BREVO_API_KEY / BREVO_SENDER_EMAIL)');
    return res.status(500).json({ error: "Envoi du code par email non configuré sur le serveur." });
  }

  const code      = String(Math.floor(1000 + Math.random() * 9000));
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const key       = 'otp_email_' + emailNorm;

  try {
    await db.collection('otp_codes').doc(key).set({
      code, expiresAt, email: emailNorm,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await _sendMailViaBrevo({
      to:      emailNorm,
      subject: 'Votre code de confirmation KAZAP',
      text:    `Votre code KAZAP : ${code} (valable 10 min)`,
      html:    `<p>Votre code KAZAP : <strong>${code}</strong> (valable 10 min)</p>`
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('[OTP Send Email] Erreur :', err);
    return res.status(500).json({ error: 'Erreur envoi OTP email : ' + err.message });
  }
});

app.post('/otp/verify', async (req, res) => {
  const { phone, code, email } = req.body;
  if (!code || (!phone && !email)) return res.status(400).json({ error: 'Données manquantes' });

  const key = email
    ? 'otp_email_' + String(email).trim().toLowerCase()
    : 'otp_' + phone.replace(/\D/g, '');
  try {
    const snap = await db.collection('otp_codes').doc(key).get();
    if (!snap.exists)             return res.status(400).json({ error: 'Code OTP introuvable. Renvoyez un nouveau code.' });
    const data = snap.data();
    if (Date.now() > data.expiresAt) return res.status(400).json({ error: 'Code OTP expiré. Renvoyez un nouveau code.' });
    if (data.code !== code)          return res.status(400).json({ error: 'Code OTP incorrect.' });

    await db.collection('otp_codes').doc(key).delete();
    return res.json({ success: true });
  } catch (err) {
    console.error('[OTP Verify] Erreur :', err);
    return res.status(500).json({ error: 'Erreur vérification OTP : ' + err.message });
  }
});

// ─── Réinitialisation du mot de passe via OTP ────────────────────────────────
// Utilisée par l'écran "Mot de passe oublié ?" du frontend. Vérifie le code
// OTP ET applique le nouveau mot de passe en une seule requête (au lieu
// d'appeler /otp/verify séparément), pour éviter de consommer le code une
// première fois côté "vérification" puis de le retrouver déjà supprimé au
// moment de changer le mot de passe. Réutilise la même collection Firestore
// 'otp_codes' et la même logique de clé que /otp/verify (inchangée).
app.post('/otp/reset-password', async (req, res) => {
  const { phone, code, email, newPassword } = req.body;
  if (!code || (!phone && !email)) return res.status(400).json({ error: 'Données manquantes' });
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères.' });
  }

  const key = email
    ? 'otp_email_' + String(email).trim().toLowerCase()
    : 'otp_' + phone.replace(/\D/g, '');
  try {
    const snap = await db.collection('otp_codes').doc(key).get();
    if (!snap.exists)                return res.status(400).json({ error: 'Code OTP introuvable. Renvoyez un nouveau code.' });
    const data = snap.data();
    if (Date.now() > data.expiresAt) return res.status(400).json({ error: 'Code OTP expiré. Renvoyez un nouveau code.' });
    if (data.code !== code)          return res.status(400).json({ error: 'Code OTP incorrect.' });

    // Le compte Firebase Auth peut avoir été créé avec l'email saisi, ou avec
    // l'email synthétique à partir du numéro (même convention que le frontend :
    // `${phone}@kazap.app`) pour les comptes inscrits par téléphone.
    const authEmail = email
      ? String(email).trim().toLowerCase()
      : `${phone.replace(/\D/g, '')}@kazap.app`;

    let userRecord;
    try {
      userRecord = await admin.auth().getUserByEmail(authEmail);
    } catch (lookupErr) {
      if (lookupErr.code === 'auth/user-not-found') {
        return res.status(404).json({ error: 'Aucun compte associé à cet email.' });
      }
      throw lookupErr;
    }

    await admin.auth().updateUser(userRecord.uid, { password: String(newPassword) });

    // Le code OTP est à usage unique : on le supprime seulement une fois le
    // mot de passe effectivement changé, pour éviter de le "brûler" si
    // updateUser() échoue.
    await db.collection('otp_codes').doc(key).delete();
    return res.json({ success: true });
  } catch (err) {
    console.error('[OTP Reset Password] Erreur :', err);
    return res.status(500).json({ error: 'Erreur lors de la réinitialisation du mot de passe : ' + err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// VOIP — Token JWT Twilio Client JS
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/voip/token', (req, res) => {
  const shopSlug = req.query.shopSlug || 'default';
  try {
    const token = new AccessToken(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_API_KEY,
      process.env.TWILIO_API_SECRET,
      { identity: `client-${shopSlug}-${Date.now()}`, ttl: 3600 }
    );
    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: process.env.TWILIO_APP_SID,
      incomingAllow: false
    });
    token.addGrant(voiceGrant);
    console.log(`[VoIP Token] Token généré pour shopSlug=${shopSlug}`);
    return res.json({ token: token.toJwt() });
  } catch (err) {
    console.error('[VoIP Token] Erreur :', err);
    return res.status(500).json({ error: 'Erreur génération token VoIP : ' + err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// VOIP — Appel sortant depuis le navigateur (Twilio.Device.connect)
// ════════════════════════════════════════════════════════════════════════════
app.post('/api/voip/incoming-call', async (req, res) => {
  const shopSlug = req.body.shopSlug || req.query.shopSlug || '';
  const callSid  = req.body.CallSid  || '';
  console.log(`[VoIP Incoming] shopSlug=${shopSlug} callSid=${callSid}`);

  const twiml = new VoiceResponse();
  try {
    let forwardNumber = process.env.TWILIO_PHONE_NUMBER;

    if (shopSlug) {
      const q = await db.collection('vendors')
        .where('boutiqueSlug', '==', shopSlug).limit(1).get();
      if (!q.empty) {
        const vendor = q.docs[0].data();
        forwardNumber = vendor?.voip?.twilioForwardNumber
                     || vendor?.voip?.number
                     || vendor?.phone
                     || forwardNumber;
        await db.collection('voip_calls').add({
          vendorId: q.docs[0].id, shopSlug, callSid,
          type: 'voip_client',
          startedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    }

    const _vcVoip = getVoiceConfig('fr'); // VoIP sortant : toujours fr par défaut (pas de vendorId connu ici)
    twiml.say({ language: _vcVoip.twilioLang, voice: _vcVoip.twilioVoice },
      'Bonjour, bienvenue sur KAZAP. Un instant, je vous mets en relation avec notre assistant.');
    twiml.dial(escapeXml(forwardNumber));
  } catch (err) {
    console.error('[VoIP Incoming] Erreur :', err);
    const _vcErr = getVoiceConfig('fr');
    twiml.say({ language: _vcErr.twilioLang, voice: _vcErr.twilioVoice }, 'Une erreur technique s\'est produite. Merci de rappeler.');
  }

  res.set('Content-Type', 'text/xml');
  return res.send(twiml.toString());
});

// ════════════════════════════════════════════════════════════════════════════
// WEBHOOKS TWILIO — Appels entrants sur le numéro physique du vendeur
// ════════════════════════════════════════════════════════════════════════════
app.post('/webhooks/twilio/:vendorId', async (req, res) => {
  const { vendorId }  = req.params;
  const callerNumber  = req.body.From    || 'unknown';
  const sessionId     = req.body.CallSid || '';
  console.log(`[Twilio] vendorId=${vendorId} caller=${callerNumber} sid=${sessionId}`);

  try {
    const vendorSnap = await db.collection('vendors').doc(vendorId).get();
    if (!vendorSnap.exists) {
      const _nfVc = getVoiceConfig('fr');
      return res.set('Content-Type', 'text/xml').send(
        `<Response><Say language="${_nfVc.twilioLang}" voice="${_nfVc.twilioVoice}">Ce numéro n'est pas configuré. Au revoir.</Say></Response>`);
    }

    const vendor = vendorSnap.data();

    // M-10b.2 — langue du vendeur
    const _wLang = vendor?.settings?.lang || 'fr';
    const _wVc   = getVoiceConfig(_wLang);

    await db.collection('voip_calls').add({
      vendorId, callerNumber, sessionId,
      provider:  'twilio',
      iaHandled: !!vendor?.voip?.unavailableMode,
      startedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // ── Vendor DISPONIBLE → transfert ───────────────────────────
    if (!vendor?.voip?.unavailableMode) {
      const realNumber = vendor?.voip?.twilioForwardNumber
                      || vendor?.voip?.forwardNumber
                      || vendor?.phone;
      if (!realNumber) {
        const _msg = _wLang === 'en'
          ? 'The person you are calling is temporarily unavailable. Goodbye.'
          : 'Le correspondant est momentanément indisponible. Au revoir.';
        return res.set('Content-Type', 'text/xml').send(
          `<Response><Say language="${_wVc.twilioLang}" voice="${_wVc.twilioVoice}">${escapeXml(_msg)}</Say></Response>`);
      }
      return res.set('Content-Type', 'text/xml').send(`
        <Response>
          <Dial timeout="20" action="${process.env.BACKEND_URL}/webhooks/twilio/${vendorId}/no-answer">
            <Number>${escapeXml(realNumber)}</Number>
          </Dial>
        </Response>`);
    }

    // ── Vendor INDISPONIBLE → IA DTMF ───────────────────────────
    const boutiqueName = vendor?.boutiqueName || (_wLang === 'en' ? 'our shop' : 'notre boutique');
    const welcomeMsg   = vendor?.settings?.iaWelcomeMsg
      || tpl('ia.welcomeDtmf', { boutique: boutiqueName }, _wLang);

    const dtmfPrompt = _wLang === 'en'
      ? 'Press 1 to hear our opening hours, or press 2 to leave a message.'
      : 'Appuyez sur 1 pour connaître nos horaires, ou sur 2 pour laisser un message.';
    const noInputMsg = _wLang === 'en'
      ? 'We did not receive your choice. Please call back. Goodbye.'
      : 'Nous n\'avons pas reçu votre choix. Merci de rappeler. Au revoir.';
    const backendUrl = process.env.BACKEND_URL || '';

    return res.set('Content-Type', 'text/xml').send(`
      <Response>
        <Say language="${_wVc.twilioLang}" voice="${_wVc.twilioVoice}">${escapeXml(welcomeMsg)}</Say>
        <Gather numDigits="1" action="${backendUrl}/webhooks/twilio/${vendorId}/gather" method="POST" timeout="10">
          <Say language="${_wVc.twilioLang}" voice="${_wVc.twilioVoice}">${escapeXml(dtmfPrompt)}</Say>
        </Gather>
        <Say language="${_wVc.twilioLang}" voice="${_wVc.twilioVoice}">${escapeXml(noInputMsg)}</Say>
      </Response>`);
  } catch (err) {
    console.error('[Twilio] Erreur :', err);
    const _errVc = getVoiceConfig('fr');
    return res.set('Content-Type', 'text/xml').send(
      `<Response><Say language="${_errVc.twilioLang}" voice="${_errVc.twilioVoice}">Une erreur technique s'est produite. Merci de rappeler.</Say></Response>`);
  }
});

// ── Sans réponse (timeout transfert) ────────────────────────────
app.post('/webhooks/twilio/:vendorId/no-answer', async (req, res) => {
  const { vendorId } = req.params;
  console.log(`[Twilio No-Answer] vendorId=${vendorId}`);
  // M-10b.2 — on charge la langue du vendeur pour la voix TTS
  let _naVc = getVoiceConfig('fr');
  let _naMsg = 'Le correspondant n\'est pas disponible pour le moment. Merci de rappeler. Au revoir.';
  try {
    const snap = await db.collection('vendors').doc(vendorId).get();
    const lang = snap.data()?.settings?.lang || 'fr';
    _naVc  = getVoiceConfig(lang);
    _naMsg = lang === 'en'
      ? 'The person you are calling is not available at the moment. Please call back. Goodbye.'
      : _naMsg;
  } catch (_) { /* fallback fr si erreur */ }
  return res.set('Content-Type', 'text/xml').send(`
    <Response>
      <Say language="${_naVc.twilioLang}" voice="${_naVc.twilioVoice}">${escapeXml(_naMsg)}</Say>
    </Response>`);
});

// ── Choix DTMF ──────────────────────────────────────────────────
app.post('/webhooks/twilio/:vendorId/gather', async (req, res) => {
  const { vendorId } = req.params;
  const digit        = req.body.Digits;
  console.log(`[Twilio Gather] vendorId=${vendorId} digit=${digit}`);

  try {
    const vendorSnap = await db.collection('vendors').doc(vendorId).get();
    const vendor     = vendorSnap.data() || {};

    // M-10b.2 — langue du vendeur
    const _gLang = vendor?.settings?.lang || 'fr';
    const _gVc   = getVoiceConfig(_gLang);

    if (digit === '1') {
      const ranges = vendor?.settings?.availabilityRanges
        || [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }];

      let msg;
      if (_gLang === 'en') {
        msg = `Our opening hours are: morning from ${ranges[0]?.start} to ${ranges[0]?.end}`
          + (ranges[1] ? `, and afternoon from ${ranges[1].start} to ${ranges[1].end}` : '')
          + '. Goodbye.';
      } else {
        msg = `Nos horaires sont : matin de ${ranges[0]?.start} à ${ranges[0]?.end}`
          + (ranges[1] ? `, et après-midi de ${ranges[1].start} à ${ranges[1].end}` : '')
          + '. Au revoir.';
      }
      return res.set('Content-Type', 'text/xml').send(
        `<Response><Say language="${_gVc.twilioLang}" voice="${_gVc.twilioVoice}">${escapeXml(msg)}</Say></Response>`);
    }

    if (digit === '2') {
      const recMsg   = _gLang === 'en'
        ? 'You can leave your message after the beep. Press the hash key to finish.'
        : 'Vous pouvez laisser votre message après le bip. Appuyez sur dièse pour terminer.';
      const doneMsg  = _gLang === 'en' ? 'Message recorded. Thank you and goodbye.' : 'Message enregistré. Merci et au revoir.';
      return res.set('Content-Type', 'text/xml').send(`
        <Response>
          <Say language="${_gVc.twilioLang}" voice="${_gVc.twilioVoice}">${escapeXml(recMsg)}</Say>
          <Record maxLength="60" finishOnKey="#" action="${process.env.BACKEND_URL}/webhooks/twilio/${vendorId}/recording" />
          <Say language="${_gVc.twilioLang}" voice="${_gVc.twilioVoice}">${escapeXml(doneMsg)}</Say>
        </Response>`);
    }

    const unknownMsg = _gLang === 'en' ? 'Choice not recognised. Goodbye.' : 'Choix non reconnu. Au revoir.';
    return res.set('Content-Type', 'text/xml').send(
      `<Response><Say language="${_gVc.twilioLang}" voice="${_gVc.twilioVoice}">${escapeXml(unknownMsg)}</Say></Response>`);
  } catch (err) {
    console.error('[Twilio Gather] Erreur :', err);
    const _errVc = getVoiceConfig('fr');
    return res.set('Content-Type', 'text/xml').send(
      `<Response><Say language="${_errVc.twilioLang}" voice="${_errVc.twilioVoice}">Erreur technique. Au revoir.</Say></Response>`);
  }
});

// ── Sauvegarde du message vocal ─────────────────────────────────
app.post('/webhooks/twilio/:vendorId/recording', async (req, res) => {
  const { vendorId }  = req.params;
  const recordingUrl  = req.body.RecordingUrl;
  const callerNumber  = req.body.From || req.body.Caller || 'unknown';
  console.log(`[Twilio Recording] vendorId=${vendorId} url=${recordingUrl}`);
  try {
    await db.collection('voip_recordings').add({
      vendorId, callerNumber, recordingUrl,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {
    console.error('[Twilio Recording] Firestore :', err);
  }
  // M-10b.2 — on tente de récupérer la langue du vendeur
  let _recVc  = getVoiceConfig('fr');
  let _recMsg = 'Merci. Au revoir.';
  try {
    const snap = await db.collection('vendors').doc(vendorId).get();
    const lang = snap.data()?.settings?.lang || 'fr';
    _recVc  = getVoiceConfig(lang);
    _recMsg = lang === 'en' ? 'Thank you. Goodbye.' : _recMsg;
  } catch (_) { /* fallback fr */ }
  return res.set('Content-Type', 'text/xml').send(`
    <Response><Say language="${_recVc.twilioLang}" voice="${_recVc.twilioVoice}">${escapeXml(_recMsg)}</Say></Response>`);
});

// ════════════════════════════════════════════════════════════════════════════
// FCM — Push Notifications
// ════════════════════════════════════════════════════════════════════════════
app.post('/api/save-fcm-token', async (req, res) => {
  const { vendorId, token } = req.body;
  if (!vendorId || !token) return res.status(400).json({ error: 'vendorId et token requis' });
  try {
    await db.collection('vendors').doc(vendorId).update({
      fcmToken:           token,
      fcmTokenUpdatedAt:  admin.firestore.FieldValue.serverTimestamp()
    });
    console.log(`✅ FCM token sauvegardé pour vendor ${vendorId}`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[FCM Save Token] Erreur :', err);
    return res.status(500).json({ error: err.message });
  }
});

async function sendFCMPush(vendorId, title, body, data = {}) {
  try {
    const vendorDoc = await db.collection('vendors').doc(vendorId).get();
    if (!vendorDoc.exists) { console.warn(`⚠️ Vendor ${vendorId} introuvable`); return null; }
    const token = vendorDoc.data()?.fcmToken;
    if (!token) { console.warn(`⚠️ Aucun FCM token pour vendor ${vendorId}`); return null; }
    const message = {
      token,
      notification: { title, body },
      data,
      webpush: {
        notification: {
          icon:    'https://votre-domaine.com/icons/icon-192x192.png',
          badge:   'https://votre-domaine.com/icons/icon-72x72.png',
          vibrate: [200, 100, 200]
        }
      }
    };
    const messageId = await admin.messaging().send(message);
    console.log(`✅ Push FCM envoyée (${messageId}) → vendor ${vendorId}`);
    return messageId;
  } catch (err) {
    console.error(`❌ sendFCMPush vendor ${vendorId} :`, err.message);
    return null;
  }
}

app.get('/test-fcm/:vendorId', async (req, res) => {
  const { vendorId } = req.params;
  if (!vendorId) return res.status(400).json({ error: 'vendorId requis' });
  const messageId = await sendFCMPush(vendorId, '🧪 Test FCM', 'FCM fonctionne ! ✅');
  res.json({ success: !!messageId, messageId });
});

// ── Messagerie écrite acheteur/vendeur — Notification FCM (Partie 2a/3) ──
app.post('/api/notify-message', async (req, res) => {
  const { vendorId, conversationId, preview } = req.body;
  if (!vendorId || !conversationId) {
    return res.status(400).json({ error: 'vendorId et conversationId requis' });
  }
  try {
    const apercu = typeof preview === 'string'
      ? (preview.length > 80 ? preview.slice(0, 80) + '…' : preview)
      : '';
    const messageId = await sendFCMPush(
      vendorId,
      'Nouveau message client',
      apercu,
      { conversationId, type: 'new_message' }
    );
    if (!messageId) {
      // Pas de token FCM ou vendor introuvable : on ne lève pas d'exception
      return res.json({ success: false, reason: 'notification non envoyée (token absent ou vendor introuvable)' });
    }
    return res.json({ success: true, messageId });
  } catch (err) {
    console.error('[Notify Message] Erreur :', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Messagerie écrite acheteur/vendeur — Interception IA M-01 optionnelle (Partie 2b/3) ──
// Strictement opt-in : ne se déclenche que si vendors/{id}.iaAutoReplyMessages === true.
// Sans cette configuration explicite, la messagerie reste 100% manuelle.
// À appeler par le frontend après écriture du nouveau message client dans
// Firestore conversations/{conversationId}/messages, pour générer la réponse
// automatique de l'assistant IA le cas échéant.
app.post('/api/ia-auto-reply-message', verifierCompteActif, async (req, res) => {
  const { vendorId, conversationId, message } = req.body;
  if (!vendorId || !conversationId || !message) {
    return res.status(400).json({ error: 'vendorId, conversationId et message requis' });
  }
  try {
    // Vérification anti-mismatch : la conversation doit bien appartenir au vendorId fourni
    // (le SDK Admin contourne les règles Firestore, donc cette vérification est faite ici)
    const conversationSnap = await db.collection('conversations').doc(conversationId).get();
    if (!conversationSnap.exists) {
      return res.status(404).json({ error: 'Conversation introuvable' });
    }
    if (conversationSnap.data()?.vendorId !== vendorId) {
      return res.status(403).json({ error: 'conversationId ne correspond pas au vendorId fourni' });
    }

    const vendorSnap = await db.collection('vendors').doc(vendorId).get();
    if (!vendorSnap.exists) {
      return res.status(404).json({ error: 'Vendor introuvable' });
    }
    const vendeurData = vendorSnap.data() || {};

    // Comportement strictement opt-in : désactivé par défaut
    // (chemin confirmé par le frontend : vendors/{uid}.settings.iaAutoReplyMessages)
    if (vendeurData?.settings?.iaAutoReplyMessages !== true) {
      return res.json({ success: false, reason: 'IA auto-reply messagerie désactivée pour ce vendeur' });
    }

    // Historique de la conversation (20 derniers messages), lu par le backend
    let historique = [];
    try {
      const historiqueSnap = await db
        .collection('conversations').doc(conversationId)
        .collection('messages')
        .orderBy('createdAt', 'asc')
        .limitToLast(20)
        .get();
      historique = historiqueSnap.docs
        .map(doc => {
          const d = doc.data() || {};
          return { role: d.sender === 'ia' ? 'ia' : 'user', texte: d.text || '' };
        })
        .filter(m => m.texte);
    } catch (errHist) {
      console.error('[IA Auto-Reply Messagerie] Lecture historique :', errHist.message);
      historique = [];
    }

    const lang     = vendeurData?.settings?.lang   || 'fr';
    const tonalite = vendeurData?.settings?.iaTone  || null;

    const resultatIA = await genererReponseIAEcrit({
      message,
      vendeurData,
      historique,
      lang,
      tonalite
    });

    // Gating plan (Partie 5/8, correctif) : genererReponseIAEcrit renvoie
    // null si le plan du vendeur n'autorise pas l'IA écrite. Il ne faut
    // jamais déstructurer un null — on répond simplement qu'aucune réponse
    // n'a été générée, sans lever d'erreur 500 pour ce cas légitime.
    if (!resultatIA) {
      return res.json({ success: false, reason: 'Réponse IA écrite non autorisée pour ce plan' });
    }
    const { reponse } = resultatIA;

    const nouveauMessageRef = await db
      .collection('conversations').doc(conversationId)
      .collection('messages')
      .add({
        text:      reponse,
        sender:    'ia',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

    console.log(`✅ Réponse IA messagerie enregistrée (${nouveauMessageRef.id}) → conversation ${conversationId}`);
    return res.json({ success: true, messageId: nouveauMessageRef.id, reponse });
  } catch (err) {
    console.error('[IA Auto-Reply Messagerie] Erreur :', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// IA VOCAL M-01 — Routes REST
// ════════════════════════════════════════════════════════════════════════════

/**
 * POST /call/incoming
 * Webhook Twilio : appel entrant sur le numéro IA du vendeur.
 * Répond avec TwiML + ouvre un Media Stream WebSocket.
 */
app.post('/call/incoming', async (req, res) => {
  const twiml   = new VoiceResponse();
  const callSid = req.body.CallSid || 'inconnu';
  const from    = req.body.From    || 'inconnu';
  const to      = req.body.To      || '';
  console.log(`📞 Appel IA entrant — CallSid: ${callSid} | De: ${from} | Vers: ${to}`);

  try {
    const vendeurId = await _trouverVendeurParNumero(to);
    if (!vendeurId) {
      const _vc = getVoiceConfig('fr');
      twiml.say({ language: _vc.twilioLang, voice: _vc.twilioVoice },
        'Désolé, ce service est temporairement indisponible. Veuillez rappeler ultérieurement.');
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    const vendeurSnap = await db.collection('vendors').doc(vendeurId).get();
    const vendeurData = vendeurSnap.data() || {};
    const iaEnabled   = vendeurData?.voip?.iaReceptionEnabled !== false;

    if (!iaEnabled) {
      const numeroRenvoi = vendeurData?.phone || vendeurData?.voip?.transferNumber;
      const _vc = getVoiceConfig(vendeurData?.settings?.lang || 'fr'); // M-10b.2
      if (numeroRenvoi) {
        twiml.say({ language: _vc.twilioLang, voice: _vc.twilioVoice }, 'Veuillez patienter, nous transférons votre appel.');
        twiml.dial(numeroRenvoi);
      } else {
        twiml.say({ language: _vc.twilioLang, voice: _vc.twilioVoice },
          'Bonjour, nous ne pouvons pas répondre pour le moment. Merci de rappeler.');
      }
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // ── Gating plan / quota IA — Partie 6/8 ─────────────────────────────────
    // Autorité serveur finale : un appel entrant ne doit jamais atteindre le
    // flux IA vocal coûteux (Twilio Connect + Deepgram + Claude) si le plan du
    // vendeur n'inclut pas l'IA vocale (Basique, ou essai expiré), ou si son
    // quota mensuel de minutes Pro (60 min) est déjà épuisé. Le toggle
    // iaReceptionEnabled ci-dessus ne suffit pas : il ne reflète que le choix
    // du vendeur, pas son plan ni sa consommation.
    if (!_accesIAAutorise(vendeurData) || !(await _quotaIADisponible(vendeurId, vendeurData))) {
      console.warn(`[Quota IA] Appel refusé avant connexion — vendeurId=${vendeurId} : accès IA non autorisé ou quota mensuel épuisé.`);
      const numeroRenvoi = vendeurData?.phone || vendeurData?.voip?.transferNumber;
      const _vcQuota = getVoiceConfig(vendeurData?.settings?.lang || 'fr');
      if (numeroRenvoi) {
        twiml.say({ language: _vcQuota.twilioLang, voice: _vcQuota.twilioVoice },
          'Veuillez patienter, nous transférons votre appel.');
        twiml.dial(numeroRenvoi);
      } else {
        twiml.say({ language: _vcQuota.twilioLang, voice: _vcQuota.twilioVoice },
          "Bonjour, notre assistante vocale est temporairement indisponible. Merci de rappeler ultérieurement.");
      }
      res.type('text/xml');
      return res.send(twiml.toString());
    }
    // ── Fin gating plan / quota IA ──────────────────────────────────────────

    const _vendorLang = vendeurData?.settings?.lang || 'fr'; // M-10b.2
    const _vc         = getVoiceConfig(_vendorLang);          // M-10b.2
    const msgAccueil  = vendeurData?.settings?.iaWelcomeMsg
      || `Bonjour, je suis l'assistante de ${vendeurData?.boutiqueName || 'la boutique'}. Comment puis-je vous aider ?`;

    twiml.say({ language: _vc.twilioLang, voice: _vc.twilioVoice }, msgAccueil);
    const connect = twiml.connect();
    connect.stream({
      url:   `wss://kazap-backend1.onrender.com/media-stream/${vendeurId}`,
      track: 'inbound_track',
      parameter: [
        { name: 'callerNumber', value: from }
      ]
    });

    await ecrireIaOrder({
      callSid, vendeurId,
      type:          'appel',
      statut:        'en_cours',
      client:        { telephone: from, nom: null },
      details:       null,
      transcription: null,
      durationSec:   null
    });

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (err) {
    console.error('POST /call/incoming erreur :', err.message);
    const _errVc = getVoiceConfig('fr');
    twiml.say({ language: _errVc.twilioLang, voice: _errVc.twilioVoice },
      'Une erreur est survenue. Veuillez rappeler dans quelques instants.');
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

/**
 * POST /call/status
 * Callback Twilio : fin ou changement de statut d'un appel IA.
 */
app.post('/call/status', async (req, res) => {
  const { CallSid, CallStatus, CallDuration, From, To } = req.body;
  console.log(`📊 Statut appel IA — CallSid: ${CallSid} | Statut: ${CallStatus} | Durée: ${CallDuration}s`);
  try {
    if (CallSid) {
      await mettreAJourStatutAppel(CallSid, {
        statut:      CallStatus === 'completed' ? 'termine' : CallStatus,
        durationSec: CallDuration ? parseInt(CallDuration, 10) : null
      });
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('POST /call/status erreur :', err.message);
    res.sendStatus(200); // Toujours 200 pour Twilio
  }
});

/**
 * GET /api/ia_orders
 * Polling REST fallback — liste les ia_orders d'un vendeur.
 */
app.get('/api/ia_orders', async (req, res) => {
  const { vendeurId, limit: lim } = req.query;
  if (!vendeurId) return res.status(400).json({ error: 'vendeurId requis' });
  try {
    const limite = Math.min(parseInt(lim, 10) || 20, 50);
    const snap   = await db.collection('ia_orders')
      .where('vendeurId', '==', vendeurId)
      .orderBy('createdAt', 'desc')
      .limit(limite)
      .get();
    const calls = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, calls });
  } catch (err) {
    console.error('GET /api/ia_orders erreur :', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/voice/toggle
 * Active ou désactive la réception IA d'un vendeur.
 */
app.post('/api/voice/toggle', async (req, res) => {
  const { vendorId, enabled } = req.body;
  if (!vendorId || enabled === undefined) {
    return res.status(400).json({ error: 'vendorId et enabled requis' });
  }
  try {
    await db.collection('vendors').doc(vendorId).update({
      'voip.iaReceptionEnabled': Boolean(enabled),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true, enabled });
  } catch (err) {
    console.error('POST /api/voice/toggle erreur :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// IA VOCAL M-01 — WebSocket Twilio Media Stream
// Audio µ-law 8kHz → Deepgram STT → Claude → Twilio TTS
// ════════════════════════════════════════════════════════════════════════════
const wss = new WebSocket.Server({ server, path: '/media-stream' });

wss.on('connection', async (wsClient, req) => {
  const pathParts  = req.url.split('/');
  const vendeurId  = pathParts[pathParts.length - 1] || null;
  console.log(`🔌 WebSocket Media Stream connecté — vendeurId: ${vendeurId}`);

  const session = {
    vendeurId,
    callSid:         null,
    streamSid:       null,
    transcription:   '',
    reponseEnCours:  false,
    vendeurData:     null,
    creneauxAgenda:  null,   // Créneaux libres injectés dans le prompt Claude
    deepgramSocket:  null,
    // Partie 6/8 — contrôle du quota IA Pro (60 min/mois) PENDANT l'appel
    callStartTimeMs:      null,  // Date.now() au moment de l'évènement Twilio "start"
    quotaCheckInterval:   null,  // handle setInterval du contrôle périodique
    quotaCoupureEnCours:  false, // évite un double déclenchement de la coupure
    // Historique pour maintenir le contexte du dialogue entre les tours
    historique:      [],
    // Données de commande accumulées au fil de la conversation
    commandeEnCours: {
      produit:    null,
      quantite:   null,
      adresse:    null,
      clientNom:  null,
      total:      0,
      confirmee:  false
    },
    // État du flux de prise de RDV (M-04)
    //   etape: null | 'PROPOSE_CRENEAU' | 'CONFIRME'
    rdvState: {
      etape:      null,
      proposals:  [],   // [{date, time, label}]
      chosenSlot: null, // {date, time, label}
      retryCount: 0,
      clientNom:  null,
      motif:      'Rendez-vous'
    }
  };

  // Charger les données du vendeur + créneaux agenda en temps réel
  if (vendeurId) {
    try {
      const snap = await db.collection('vendors').doc(vendeurId).get();
      session.vendeurData = snap.exists ? snap.data() : null;
    } catch (e) {
      console.warn('⚠️ Impossible de charger les données vendeur :', e.message);
    }

    // Lire les créneaux libres AVANT le premier tour IA (timeout 3s)
    try {
      const agendaPromise  = getCreneauxPourIA(vendeurId);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout agenda')), 3000)
      );
      session.creneauxAgenda = await Promise.race([agendaPromise, timeoutPromise]);
      console.log(`📅 Agenda chargé pour ${vendeurId} : ${session.creneauxAgenda}`);
    } catch (agendaErr) {
      console.warn('⚠️ Agenda non disponible :', agendaErr.message);
      session.creneauxAgenda = null;
    }
  }

  // Initialiser Deepgram STT — M-10b.2 : langue dynamique selon vendeur
  try {
    const _sessionLang = session.vendeurData?.settings?.lang || 'fr';
    const _sessionVC   = getVoiceConfig(_sessionLang);
    session.deepgramSocket = await traiterAudioStream({
      vendorLang:   _sessionLang,            // T-06 P4 — langue vendeur ('fr','en','fon','yor')
      deepgramLang: _sessionVC.deepgramLang, // M-10b.2 — 'fr' ou 'en'
      onTranscription: async (texte, isFinal) => {
        if (!texte || !isFinal) return;
        session.transcription += ' ' + texte;
        console.log(`📝 Transcription : "${texte.trim()}"`);
        if (session.reponseEnCours) return;
        session.reponseEnCours = true;

        try {
          // Ajouter le tour client à l'historique
          session.historique.push({ role: 'client', texte: texte.trim() });

          // ══════════════════════════════════════════════════════════════
          // FLUX RDV (M-04) — machine à états déterministe, prioritaire
          // Si un flux RDV est en cours, on traite la réponse du client
          // ici directement (sans repasser par Claude) pour garantir que
          // les créneaux annoncés/confirmés correspondent EXACTEMENT à
          // l'agenda Firestore.
          // ══════════════════════════════════════════════════════════════
          if (session.rdvState.etape) {
            const rdvResult = await _traiterEtapeRdv(session, texte.trim(), vendeurId);

            session.historique.push({ role: 'ia', texte: rdvResult.reponse });
            if (session.historique.length > 20) {
              session.historique = session.historique.slice(-20);
            }

            console.log(`📅 [RDV] étape=${session.rdvState.etape || 'TERMINE'} : "${rdvResult.reponse}"`);

            if (session.callSid) {
              await _injecterTwiML(session.callSid, rdvResult.reponse, vendeurId);
            }

            return; // on ne passe pas par genererReponseIA pour ce tour
          }

          const { reponse, type, details, statutCommande } = await genererReponseIA({
            transcription:  texte.trim(),
            vendeurData:    session.vendeurData,
            historique:     session.historique,
            creneauxAgenda: session.creneauxAgenda,  // Créneaux agenda injectés dans le prompt
            lang:           session.vendeurData?.settings?.lang || 'fr'  // M-10b.2
          });

          // Ajouter la réponse IA à l'historique
          session.historique.push({ role: 'ia', texte: reponse });

          // Limiter l'historique à 20 tours pour ne pas saturer le contexte
          if (session.historique.length > 20) {
            session.historique = session.historique.slice(-20);
          }

          console.log(`🤖 Réponse IA [${type}] statut=${statutCommande || 'n/a'} : "${reponse}"`);

          // ── Fusionner les données de commande collectées ──────────────
          if (type === 'commande' && details) {
            const c = session.commandeEnCours;
            if (details.produit    ) c.produit   = details.produit;
            if (details.quantite   ) c.quantite  = details.quantite;
            if (details.adresse    ) c.adresse   = details.adresse;
            if (details.clientNom  ) c.clientNom = details.clientNom;
            if (details.total      ) c.total     = details.total;
          }

          // ══════════════════════════════════════════════════════════════
          // FLUX RDV (M-04) — démarrage
          // Claude vient de détecter une intention "rdv" et il n'y a pas
          // encore de flux RDV en cours. On démarre PROPOSE_CRENEAU et on
          // REMPLACE la réponse vocale de Claude par les vraies propositions
          // calculées à partir de l'agenda Firestore (pour ne jamais
          // annoncer un créneau qui n'existe pas).
          // ══════════════════════════════════════════════════════════════
          let reponseFinale = reponse;
          if (type === 'rdv' && !session.rdvState.etape) {
            // ── Gating plan (ajout — Partie 5/8, tâche 2 : RDV via agenda
            // intelligent) ────────────────────────────────────────────────
            // Réutilise _accesIAAutorise (même règle que IA vocale/écrite/
            // SMS — kazapP10_hasFeature('agenda', plan)). Repli silencieux :
            // le flux RDV déterministe ne démarre simplement pas et
            // reponseFinale reste la réponse générique de Claude, sans
            // jamais faire échouer l'appel en cours.
            if (!_accesIAAutorise(session.vendeurData)) {
              console.warn(`⛔ RDV agenda intelligent — accès refusé (plan insuffisant) — vendeurId: ${vendeurId}`);
            } else {
            // ── Fin ajout gating plan ─────────────────────────────────────
            if (details?.clientNom) session.rdvState.clientNom = details.clientNom;
            if (details?.motif)     session.rdvState.motif     = details.motif;

            const { slots, text } = await RdvBooking.buildProposals(vendeurId);

            if (slots.length === 0) {
              // Pas de créneau dispo : on garde la réponse de Claude (transmission équipe)
              reponseFinale = text;
            } else {
              session.rdvState.etape     = 'PROPOSE_CRENEAU';
              session.rdvState.proposals = slots;
              reponseFinale = text;
              // Remplacer la dernière entrée d'historique IA par le texte réel envoyé
              session.historique[session.historique.length - 1].texte = reponseFinale;
            }
            }
          }

          // Injecter la réponse vocale via l'API REST Twilio
          if (session.callSid) {
            await _injecterTwiML(session.callSid, reponseFinale, vendeurId);
          }

          // ── Commande CONFIRMÉE par le client ─────────────────────────
          if (type === 'commande' && statutCommande === 'confirmee' && !session.commandeEnCours.confirmee) {
            session.commandeEnCours.confirmee = true;
            const c      = session.commandeEnCours;
            const ordreId = 'IA-' + Date.now().toString(36).toUpperCase();

            // Écrire / mettre à jour ia_orders avec statut 'commande' confirmée
            await ecrireIaOrder({
              callSid:       session.callSid,
              vendeurId,
              type:          'commande',
              statut:        'nouveau',
              client:        { nom: c.clientNom, telephone: session.callerId },
              details:       `Commande ${ordreId} — ${c.quantite}× ${c.produit} — ${Number(c.total).toLocaleString('fr-FR')} FCFA — Livraison : ${c.adresse || 'non précisée'}`,
              transcription: session.transcription.trim(),
              durationSec:   null
            });

            // Notifications SMS client + vendeur
            await _notifierCommandeIA({
              vendeurId,
              vendeurData: session.vendeurData,
              ordreId,
              details: { ...c, ...details },
              clientPhone: session.callerId
            });

            // Notification FCM
            await sendFCMPush(
              vendeurId,
              '🛒 Nouvelle commande IA !',
              `${c.clientNom || 'Client'} — ${c.quantite}× ${c.produit}`,
              { type: 'commande', source: 'ia_vocal', clickUrl: '/dashboard?section=commandes' }
            );

            console.log(`✅ Commande IA confirmée et enregistrée — ${ordreId}`);

          // ── Commande ANNULÉE par le client ───────────────────────────
          } else if (type === 'commande' && statutCommande === 'annulee') {
            await mettreAJourStatutAppel(session.callSid, {
              statut:  'annulee',
              details: 'Commande annulée par le client pendant l\'appel'
            });
            console.log('⚠️ Commande annulée par le client');

          // ── Commande EN COURS ou autre type : mise à jour statut ─────
          } else if (type === 'commande' || type === 'rdv') {
            await mettreAJourStatutAppel(session.callSid, {
              type,
              details:       details?.resume || reponse,
              transcription: session.transcription.trim(),
              statut:        'ia_handled'
            });

            // RDV détecté : FCM
            if (type === 'rdv') {
              await sendFCMPush(vendeurId, '📅 Nouveau RDV IA !', details?.resume || reponse,
                { type, source: 'ia_vocal', clickUrl: '/dashboard?section=agenda' });
            }

          } else {
            // Info / inconnu : simple mise à jour de transcription
            await mettreAJourStatutAppel(session.callSid, {
              type, details: details?.resume || reponse,
              transcription: session.transcription.trim(),
              statut: 'ia_handled'
            });
          }

        } catch (err) {
          console.error('❌ Erreur traitement IA :', err.message);
        } finally {
          session.reponseEnCours = false;
        }
      },
      onErreur: (err) => console.error('❌ Erreur Deepgram :', err.message || err)
    });
  } catch (err) {
    console.error('❌ Impossible d\'initialiser Deepgram :', err.message);
    wsClient.close();
    return;
  }

  // Réception des messages Twilio Media Stream
  wsClient.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      switch (msg.event) {
        case 'connected':
          console.log('✅ Twilio Media Stream connecté');
          break;
        case 'start':
          session.callSid   = msg.start?.callSid  || null;
          session.streamSid = msg.start?.streamSid || null;
          // Récupérer le numéro du client depuis les custom parameters Twilio
          session.callerId  = msg.start?.customParameters?.callerNumber
                           || msg.start?.customParameters?.From
                           || null;
          console.log(`▶️  Stream démarré — CallSid: ${session.callSid} | Caller: ${session.callerId || '—'}`);
          // Partie 6/8 — démarre le contrôle périodique du quota IA Pro
          // (60 min/mois), seulement maintenant que callSid + heure de départ
          // réels de l'appel sont connus.
          session.callStartTimeMs = Date.now();
          _demarrerControleQuotaEnCours(session, vendeurId);
          break;
        case 'media':
          if (msg.media?.payload && session.deepgramSocket?.readyState === WebSocket.OPEN) {
            session.deepgramSocket.send(Buffer.from(msg.media.payload, 'base64'));
          }
          break;
        case 'stop':
          console.log(`⏹️  Stream arrêté — CallSid: ${session.callSid}`);
          if (session.quotaCheckInterval) clearInterval(session.quotaCheckInterval);
          if (session.deepgramSocket?.readyState === WebSocket.OPEN) session.deepgramSocket.close();
          break;
      }
    } catch (err) {
      console.error('❌ Erreur parsing WebSocket :', err.message);
    }
  });

  wsClient.on('close', () => {
    console.log(`🔌 WebSocket fermé — vendeurId: ${vendeurId}`);
    if (session.quotaCheckInterval) clearInterval(session.quotaCheckInterval);
    if (session.deepgramSocket?.readyState === WebSocket.OPEN) session.deepgramSocket.close();
  });

  wsClient.on('error', (err) => console.error('❌ Erreur WebSocket client :', err.message));
});

// ════════════════════════════════════════════════════════════════════════════
// FONCTIONS UTILITAIRES
// ════════════════════════════════════════════════════════════════════════════

function escapeXml(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

async function _trouverVendeurParNumero(numero) {
  if (!numero) return null;
  try {
    const snap = await db.collection('vendors')
      .where('voip.number', '==', numero).limit(1).get();
    return snap.empty ? null : snap.docs[0].id;
  } catch (err) {
    console.error('_trouverVendeurParNumero erreur :', err.message);
    return null;
  }
}

async function _injecterTwiML(callSid, texte, vendeurId) {
  try {
    let accountSid = process.env.TWILIO_ACCOUNT_SID;
    let authToken  = process.env.TWILIO_AUTH_TOKEN;
    let lang       = 'fr'; // M-10b.2 — langue par défaut
    if (vendeurId) {
      const snap = await db.collection('vendors').doc(vendeurId).get();
      const data = snap.data() || {};
      const voip = data.voip || {};
      if (voip.twilioAccountSid && voip.twilioAuthToken) {
        accountSid = voip.twilioAccountSid;
        authToken  = voip.twilioAuthToken;
      }
      lang = data?.settings?.lang || 'fr'; // M-10b.2
    }
    const vc     = getVoiceConfig(lang); // M-10b.2
    const client = twilio(accountSid, authToken);
    const twiml  = new VoiceResponse();
    twiml.say({ language: vc.twilioLang, voice: vc.twilioVoice }, texte);
    const connect = twiml.connect();
    connect.stream({ url: `wss://kazap-backend1.onrender.com/media-stream/${vendeurId}` });
    await client.calls(callSid).update({ twiml: twiml.toString() });
    console.log(`🔊 TwiML injecté dans l'appel ${callSid}`);
  } catch (err) {
    console.error('❌ _injecterTwiML erreur :', err.message);
  }
}

/**
 * _demarrerControleQuotaEnCours — Partie 6/8.
 * Lance un contrôle du quota IA Pro toutes les 30 secondes pendant que
 * l'appel est en cours. Ne s'applique qu'au plan Pro (limite 60 min/mois) :
 *   - Premium (illimité) et essai actif (accès Premium complet) → jamais coupés,
 *     on ne lance même pas le minuteur pour éviter des lectures Firestore inutiles.
 *   - Basique / compte bloqué → n'atteignent normalement jamais ce point,
 *     l'appel ayant déjà été refusé en amont par le gating de /call/incoming ;
 *     on ne relance donc pas de minuteur ici non plus (défense en profondeur,
 *     pas un chemin normal).
 *
 * @param {object} session   — session WebSocket media-stream en cours
 * @param {string} vendeurId
 */
function _demarrerControleQuotaEnCours(session, vendeurId) {
  const vendeurData = session.vendeurData;
  if (_compteEstBloque(vendeurData)) return;
  if (_essaiEncoreActif(vendeurData)) return;
  if (_normaliserPlan(vendeurData) !== 'pro') return; // 'premium' illimité

  const QUOTA_CHECK_INTERVAL_MS = 30_000;
  session.quotaCheckInterval = setInterval(async () => {
    if (session.quotaCoupureEnCours || !session.callSid || !session.callStartTimeMs) return;
    try {
      const elapsedSec = Math.floor((Date.now() - session.callStartTimeMs) / 1000);
      const depasse = await _quotaIADepasseEnCours(vendeurId, session.vendeurData, elapsedSec);
      if (depasse) {
        session.quotaCoupureEnCours = true;
        clearInterval(session.quotaCheckInterval);
        console.warn(`⏱️ [Quota IA] Limite Pro (${KAZAP_IA_CALL_LIMITS.pro} min) atteinte en cours d'appel — vendeurId=${vendeurId} callSid=${session.callSid}`);
        await _couperAppelQuotaAtteint(session, vendeurId);
      }
    } catch (err) {
      console.error('[Quota IA en cours] Erreur contrôle périodique :', err.message);
    }
  }, QUOTA_CHECK_INTERVAL_MS);
}

/**
 * _couperAppelQuotaAtteint — Partie 6/8.
 * Termine proprement un appel Pro dès que le quota de 60 min/mois est atteint
 * PENDANT l'appel : informe l'appelant par un message vocal court, puis
 * raccroche (Twilio <Hangup/>), sans erreur technique brutale. Met aussi à
 * jour ia_orders / appointments-like statut pour traçabilité, et ferme la
 * connexion Deepgram pour libérer les ressources côté serveur.
 *
 * @param {object} session   — session WebSocket media-stream en cours
 * @param {string} vendeurId
 */
async function _couperAppelQuotaAtteint(session, vendeurId) {
  const msgFin = "Je suis désolée, la durée d'utilisation de l'assistante vocale pour ce mois a été atteinte. Le service redevient disponible le mois prochain. Vous pouvez aussi passer à un plan supérieur. Au revoir.";

  try {
    if (session.callSid) {
      let accountSid = process.env.TWILIO_ACCOUNT_SID;
      let authToken  = process.env.TWILIO_AUTH_TOKEN;
      let lang       = 'fr';
      if (vendeurId) {
        const snap = await db.collection('vendors').doc(vendeurId).get();
        const data = snap.data() || {};
        const voip = data.voip || {};
        if (voip.twilioAccountSid && voip.twilioAuthToken) {
          accountSid = voip.twilioAccountSid;
          authToken  = voip.twilioAuthToken;
        }
        lang = data?.settings?.lang || 'fr';
      }
      const vc     = getVoiceConfig(lang);
      const client = twilio(accountSid, authToken);
      const twiml  = new VoiceResponse();
      twiml.say({ language: vc.twilioLang, voice: vc.twilioVoice }, msgFin);
      twiml.hangup();
      await client.calls(session.callSid).update({ twiml: twiml.toString() });
      console.log(`📴 Appel ${session.callSid} raccroché proprement (quota IA Pro atteint).`);
    }
  } catch (err) {
    console.error('❌ Erreur raccrochage quota atteint :', err.message);
  } finally {
    try {
      if (session.callSid) {
        await mettreAJourStatutAppel(session.callSid, {
          statut:  'quota_depasse',
          details: "Appel interrompu automatiquement : quota d'appel IA Pro (60 min/mois) atteint pendant l'appel.",
          transcription: session.transcription?.trim() || null
        });
      }
    } catch (e) {
      console.warn('[Quota IA] mettreAJourStatutAppel erreur :', e.message);
    }
    // Ferme proprement la connexion Deepgram (signal CloseStream avant fermeture),
    // même si le client Twilio met encore quelques instants à raccrocher.
    fermerDeepgram(session.deepgramSocket);
  }
}

function _extraireClient(details) {
  if (!details) return { nom: null, telephone: null };
  return {
    nom:       details.clientNom       || details.nom       || null,
    telephone: details.clientTelephone || details.telephone || null
  };
}

// ════════════════════════════════════════════════════════════════════════════
// RDV (M-04) — Machine à états : ATTEND_CHOIX → CONFIRME → VALIDE / ANNULE
// ════════════════════════════════════════════════════════════════════════════

/**
 * _traiterEtapeRdv
 * Traite un tour de conversation pendant un flux RDV en cours
 * (session.rdvState.etape !== null). Met à jour session.rdvState et,
 * le cas échéant, écrit le RDV dans Firestore + envoie le SMS + notifie FCM.
 *
 * @param {object} session  — session WebSocket en cours
 * @param {string} texte    — transcription du client pour ce tour
 * @param {string} vendeurId
 * @returns {Promise<{ reponse: string }>}
 */
async function _traiterEtapeRdv(session, texte, vendeurId) {
  const rdv = session.rdvState;
  const MAX_RETRY = 2;

  // ── PROPOSE_CRENEAU : on attend le choix du client ──────────────────────
  if (rdv.etape === 'PROPOSE_CRENEAU') {
    const chosen = RdvBooking.parseClientChoice(texte, rdv.proposals);

    if (!chosen) {
      rdv.retryCount++;
      if (rdv.retryCount > MAX_RETRY) {
        // Trop d'essais infructueux : on abandonne le flux RDV
        const reponse = "Je suis désolée, je n'ai pas réussi à comprendre votre choix. Je transmets votre demande de rendez-vous à l'équipe, qui vous recontactera.";
        await mettreAJourStatutAppel(session.callSid, {
          type:    'rdv',
          statut:  'ia_handled',
          details: 'RDV non finalisé — choix client incompris après plusieurs tentatives',
          transcription: session.transcription.trim()
        });
        _resetRdvState(rdv);
        return { reponse };
      }
      return { reponse: RdvBooking.formatRelance(rdv.proposals) };
    }

    rdv.chosenSlot  = chosen;
    rdv.etape       = 'CONFIRME';
    rdv.retryCount  = 0;
    return { reponse: `Parfait, je vous note pour ${chosen.label}. C'est bien cela ?` };
  }

  // ── CONFIRME : oui / non ────────────────────────────────────────────────
  if (rdv.etape === 'CONFIRME') {
    if (RdvBooking.ouiConfirme(texte)) {
      const chosen = rdv.chosenSlot;
      const clientPhone = session.callerId || '';
      const clientName  = rdv.clientNom || null;

      try {
        const { firestoreId } = await RdvBooking.saveAppointment({
          vendorId:    vendeurId,
          callSid:     session.callSid,
          clientName,
          clientPhone,
          date:        chosen.date,
          time:        chosen.time,
          motif:       rdv.motif
        });

        // SMS de rappel — non bloquant
        RdvBooking.sendRdvSms({
          vendorId:    vendeurId,
          clientPhone,
          clientName,
          date:        chosen.date,
          time:        chosen.time
        }).catch(e => console.warn('[rdv] sendRdvSms erreur :', e.message));

        // Notification FCM au vendeur
        await sendFCMPush(vendeurId, '📅 Nouveau RDV IA !',
          `RDV confirmé ${chosen.label}${clientName ? ' — ' + clientName : ''}`,
          { type: 'rdv', source: 'ia_vocal', clickUrl: '/dashboard?section=agenda' });

        await mettreAJourStatutAppel(session.callSid, {
          type:    'rdv',
          statut:  'ia_handled',
          details: `RDV confirmé ${chosen.label}${clientName ? ' — ' + clientName : ''}`,
          transcription: session.transcription.trim()
        });

        console.log(`✅ RDV IA confirmé et enregistré — ${firestoreId}`);

        const reponse = `Votre rendez-vous est confirmé ${chosen.label}. Vous recevrez un SMS de rappel. Merci et à bientôt !`;
        _resetRdvState(rdv);
        return { reponse };

      } catch (e) {
        console.error('[rdv] Erreur saveAppointment :', e.message);
        const reponse = "Votre rendez-vous a bien été noté, mais une erreur technique m'empêche de l'enregistrer automatiquement. L'équipe vous contactera pour confirmer.";
        _resetRdvState(rdv);
        return { reponse };
      }
    }

    if (RdvBooking.nonRefuse(texte)) {
      // Retour au choix : on redonne les mêmes propositions
      rdv.etape      = 'PROPOSE_CRENEAU';
      rdv.chosenSlot = null;
      rdv.retryCount = 0;
      const labels = rdv.proposals.map((s, i) => `le ${['premier', 'deuxième', 'troisième'][i]}, ${s.label}`).join(', ou ');
      return { reponse: `D'accord, souhaitez-vous choisir un autre créneau ? Je vous rappelle : ${labels}.` };
    }

    // Réponse ambiguë → redemander confirmation
    return { reponse: `Pardonnez-moi, je n'ai pas bien entendu. Confirmez-vous le rendez-vous prévu ${rdv.chosenSlot.label} ? Dites oui ou non.` };
  }

  // État inconnu : on réinitialise par sécurité
  _resetRdvState(rdv);
  return { reponse: "Je n'ai pas bien suivi, pouvez-vous répéter votre demande de rendez-vous ?" };
}

function _resetRdvState(rdv) {
  rdv.etape      = null;
  rdv.proposals  = [];
  rdv.chosenSlot = null;
  rdv.retryCount = 0;
}

// ════════════════════════════════════════════════════════════════════════════
// T-07-C : Webhook alerte downtime (UptimeRobot → SMS admin via Twilio)
// ════════════════════════════════════════════════════════════════════════════
// Variable d'env requise sur Render :
//   ADMIN_PHONE  → Numéro de l'admin en format E.164 (ex: +22961000000)
//
// Configuration UptimeRobot :
//   Alert Contacts → Add → Webhook → URL :
//   https://kazap-backend1.onrender.com/uptime-alert
// ════════════════════════════════════════════════════════════════════════════
app.post('/uptime-alert', async (req, res) => {
  try {
    const { monitorFriendlyName, alertType, alertDetails } = req.body;

    console.log(`[T-07-C] UptimeRobot webhook reçu — type: ${alertType}, monitor: ${monitorFriendlyName}`);

    if (alertType === 'DOWN') {
      const adminPhone = process.env.ADMIN_PHONE;

      if (!adminPhone) {
        console.warn('[T-07-C] ADMIN_PHONE non configuré — SMS d\'alerte ignoré');
      } else {
        await twilioClient.messages.create({
          body: `🚨 KAZAP ALERT: ${monitorFriendlyName} est DOWN. ${alertDetails || 'Aucun détail.'}`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to:   adminPhone
        });
        console.log(`[T-07-C] SMS d'alerte downtime envoyé à ADMIN_PHONE`);
      }
    }

    // Toujours répondre 200 — UptimeRobot désactive le webhook si réponse non-200
    res.status(200).json({ received: true });

  } catch (err) {
    console.error('[T-07-C] Erreur webhook /uptime-alert :', err.message);
    // On répond 200 malgré l'erreur pour ne pas déclencher de retry UptimeRobot
    res.status(200).json({ received: true, error: err.message });
  }
});
// === FIN T-07-C ==============================================================

// ════════════════════════════════════════════════════════════════════════════
// T-07-F : Webhook FedaPay → Activation du plan vendeur dans Firestore
//
// Variable d'env requise sur Render :
//   FEDAPAY_WEBHOOK_SECRET  → Secret de signature disponible dans
//                             dashboard.fedapay.com > Paramètres > Webhooks
//
// Configuration FedaPay :
//   dashboard.fedapay.com > Paramètres > Webhooks > Ajouter
//   URL : https://kazap-backend1.onrender.com/webhook/fedapay
//   Événements à cocher : transaction.approved
//
// Principe de sécurité :
//   FedaPay signe le corps brut (raw body) avec HMAC-SHA256.
//   En-tête reçu : x-fedapay-signature: sha256=<hex_digest>
//   On vérifie AVANT tout traitement. Si la signature ne correspond pas → 401.
//
// Idempotence :
//   Si vendors/{uid}.planFedapayRef === transaction.reference déjà stockée,
//   on répond 200 sans ré-activer (protection contre les rejeux webhook).
//
// Règle non négociable :
//   Ce endpoint est LA SEULE source d'activation de plan.
//   Le client HTML ne modifie JAMAIS Firestore pour le plan.
// ════════════════════════════════════════════════════════════════════════════

// Middleware de capture du corps brut uniquement pour cette route
// (doit être déclaré AVANT app.use(express.json()) pour la route concernée)
app.use('/webhook/fedapay', express.raw({ type: '*/*' }));

app.post('/webhook/fedapay', async (req, res) => {
  // ── Réponse rapide (<5s) garantie via ce flag ─────────────────────────────
  let responded = false;
  const _respond = (status, body) => {
    if (!responded) {
      responded = true;
      res.status(status).json(body);
    }
  };

  // Timeout de sécurité : répondre 200 au plus tard dans 4,5s pour éviter
  // que FedaPay considère le webhook comme échoué (timeout à 5s).
  const _safetyTimeout = setTimeout(() => {
    console.warn('[T-07-F] Timeout de sécurité atteint — réponse 200 forcée');
    _respond(200, { received: true, warning: 'processing_timeout' });
  }, 4500);

  try {
    // ── ÉTAPE 1 : Vérification de la signature HMAC-SHA256 ─────────────────
    const webhookSecret = process.env.FEDAPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('[T-07-F] FEDAPAY_WEBHOOK_SECRET non configuré — webhook rejeté');
      clearTimeout(_safetyTimeout);
      return _respond(500, { error: 'Configuration serveur incomplète' });
    }

    const rawBody      = req.body; // Buffer (grâce à express.raw)
    const sigHeader    = req.headers['x-fedapay-signature'] || '';
    const [, received] = sigHeader.split('sha256=');

    if (!received) {
      console.warn('[T-07-F] En-tête x-fedapay-signature absent ou mal formé');
      clearTimeout(_safetyTimeout);
      return _respond(401, { error: 'Signature absente' });
    }

    const expected = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    const sigValid = crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(received, 'hex')
    );

    if (!sigValid) {
      console.warn('[T-07-F] Signature HMAC invalide — webhook rejeté');
      clearTimeout(_safetyTimeout);
      return _respond(401, { error: 'Signature invalide' });
    }

    // ── ÉTAPE 2 : Parsing et validation de l'événement ────────────────────
    let event;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch (parseErr) {
      console.error('[T-07-F] Corps JSON invalide :', parseErr.message);
      clearTimeout(_safetyTimeout);
      return _respond(400, { error: 'Corps JSON invalide' });
    }

    // FedaPay envelope : { name: 'transaction.approved', transaction: { ... } }
    const eventName   = event.name || event.event || '';
    const transaction = event.transaction || event.data || event;

    console.log(`[T-07-F] Événement reçu : ${eventName} — txId: ${transaction?.id}`);

    // On ne traite que les transactions approuvées
    const status = (transaction?.status || '').toLowerCase();
    if (!['approved', 'complete', 'completed'].includes(status) &&
        eventName !== 'transaction.approved') {
      console.log(`[T-07-F] Événement ignoré (statut: ${status}, événement: ${eventName})`);
      clearTimeout(_safetyTimeout);
      return _respond(200, { received: true, ignored: true });
    }

    // ── ÉTAPE 3 : Extraction et validation des métadonnées ─────────────────
    const meta       = transaction?.custom_metadata || transaction?.metadata || {};
    const vendorUid  = meta.vendor_uid;
    const planKey    = meta.plan_key;
    // [Partie 3/8] Libellés exacts envoyés par FedaPay Checkout.js (metadata.period,
    // cf. index.html Partie 6/12 — openAboPaymentModal / data-period des boutons de
    // période) : 'semaine' | 'mois' | 'an'. Ce ne sont PAS les valeurs anglaises
    // 'weekly'/'monthly'/'annual' qu'un ancien code pouvait attendre.
    const period     = meta.period     || 'mois';
    const source     = meta.source     || '';
    const reference  = transaction?.reference || transaction?.id?.toString() || '';
    const fedapayId  = transaction?.id?.toString() || '';
    const amount     = transaction?.amount || 0;

    // Validation des champs obligatoires
    if (!vendorUid) {
      console.error('[T-07-F] vendor_uid manquant dans custom_metadata');
      clearTimeout(_safetyTimeout);
      return _respond(400, { error: 'vendor_uid manquant' });
    }

    if (source !== 'kazap_subscription') {
      console.warn(`[T-07-F] source ignorée : "${source}" (attendu: kazap_subscription)`);
      clearTimeout(_safetyTimeout);
      return _respond(200, { received: true, ignored: true });
    }

    const PLANS_VALIDES = ['basique', 'pro', 'premium'];
    if (!PLANS_VALIDES.includes(planKey)) {
      console.error(`[T-07-F] planKey invalide : "${planKey}"`);
      clearTimeout(_safetyTimeout);
      return _respond(400, { error: `Plan invalide : ${planKey}` });
    }

    // ── ÉTAPE 4 : Idempotence — éviter les doubles activations ─────────────
    const vendorRef  = db.collection('vendors').doc(vendorUid);
    const vendorSnap = await vendorRef.get();

    if (!vendorSnap.exists) {
      console.error(`[T-07-F] Vendor introuvable : ${vendorUid}`);
      clearTimeout(_safetyTimeout);
      return _respond(404, { error: 'Vendor introuvable' });
    }

    const vendorData       = vendorSnap.data();
    const existingFedapayRef = vendorData?.planFedapayRef || null;

    if (reference && existingFedapayRef === reference) {
      console.log(`[T-07-F] Webhook déjà traité (planFedapayRef: ${reference}) — skip`);
      clearTimeout(_safetyTimeout);
      return _respond(200, { received: true, already_processed: true });
    }

    // ── ÉTAPE 5 : Calcul de la date d'expiration ───────────────────────────
    // [Partie 3/8] Trois durées réelles, gérées explicitement (période inconnue
    // ou absente → repli sur 'mois', comportement historique le plus sûr) :
    //   'semaine' → +7 jours   |   'mois' → +1 mois   |   'an' → +1 an
    const now        = new Date();
    let   expiration = new Date(now);

    if (period === 'semaine') {
      expiration.setDate(expiration.getDate() + 7);
    } else if (period === 'an') {
      expiration.setFullYear(expiration.getFullYear() + 1);
    } else {
      // 'mois', ou toute valeur non reconnue : mensuel par défaut.
      expiration.setMonth(expiration.getMonth() + 1);
    }

    // ── ÉTAPE 6 : Activation du plan dans Firestore ─────────────────────────
    await vendorRef.set({
      plan:               planKey,
      planPeriod:         period,
      planActivatedAt:    admin.firestore.FieldValue.serverTimestamp(),
      planExpiresAt:      admin.firestore.Timestamp.fromDate(expiration),
      planAmountPaidFCFA: amount,
      planFedapayRef:     reference,
      planFedapayId:      fedapayId,
      updatedAt:          admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    console.log(`[T-07-F] ✅ Plan "${planKey}" (${period}) activé pour vendor ${vendorUid}`);
    console.log(`[T-07-F]    Expire le : ${expiration.toISOString()}`);
    console.log(`[T-07-F]    Référence FedaPay : ${reference}`);

    // ── ÉTAPE 7 : Notification FCM au vendeur (optionnel, non bloquant) ────
    sendFCMPush(
      vendorUid,
      '🎉 Plan KAZAP activé !',
      `Votre plan ${planKey.charAt(0).toUpperCase() + planKey.slice(1)} est maintenant actif.`,
      { type: 'plan_activated', plan: planKey, clickUrl: '/dashboard?section=abonnement' }
    ).catch(e => console.warn('[T-07-F] FCM plan_activated :', e.message));

    clearTimeout(_safetyTimeout);
    return _respond(200, { received: true, plan: planKey, vendor: vendorUid });

  } catch (err) {
    console.error('[T-07-F] Erreur inattendue webhook FedaPay :', err.message);
    clearTimeout(_safetyTimeout);
    // 500 → FedaPay retentera le webhook (comportement souhaité en cas d'erreur serveur)
    return _respond(500, { error: 'Erreur interne serveur' });
  }
});
// === FIN T-07-F ==============================================================

// ════════════════════════════════════════════════════════════════════════════
// DÉMARRAGE
// ════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 KAZAP Backend démarré sur le port ${PORT}`);
  console.log(`   URL : https://kazap-backend1.onrender.com`);
});

// _accesIAAutorise exportée en plus de { app, server } — requise par
// claude-agent.js (genererReponseIAEcrit, Partie 5/8) via un require()
// différé (voir commentaire dans claude-agent.js pour la dépendance
// circulaire). Sans cet export, la déstructuration y renvoyait `undefined`
// et faisait planter tout appel de réponse IA écrite (Partie 5/8, correctif).
module.exports = { app, server, _accesIAAutorise };
