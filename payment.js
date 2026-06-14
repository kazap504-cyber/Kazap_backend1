/**
 * ════════════════════════════════════════════════════════════════════════════
 *  M-08 — MODULE PAIEMENT MOBILE MONEY — CinetPay
 *  Fichier : payment.js
 *  À monter dans le backend KAZAP existant (kazap-backend1, Express + firebase-admin)
 *
 *  Dépendances npm :
 *    npm install axios crypto twilio
 *    (firebase-admin déjà installé et initialisé dans le backend)
 *
 *  Variables d'environnement requises :
 *    CINETPAY_API_KEY        — clé API CinetPay (compte marchand KAZAP)
 *    CINETPAY_SITE_ID        — identifiant du site CinetPay
 *    CINETPAY_SECRET_KEY     — clé secrète utilisée pour vérifier la signature webhook
 *    KAZAP_BASE_URL          — URL publique du backend (ex: https://kazap-backend1.onrender.com)
 *    KAZAP_FRONTEND_URL      — URL de la boutique publique (page de retour client)
 *    TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER — fallback si non
 *                              stockés dans Firestore vendors/:vendorId.voip
 *
 *  Usage dans app.js / server.js existant :
 *    const paymentRouter = require('./payment');
 *    app.use('/api/payment', paymentRouter);
 * ════════════════════════════════════════════════════════════════════════════
 */

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const admin = require('firebase-admin'); // déjà initialisé dans le backend principal
const twilio = require('twilio');

const router = express.Router();

// ────────────────────────────────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────────────────────────────────
const CINETPAY_API_URL = 'https://api-checkout.cinetpay.com/v2/payment';
const CINETPAY_CHECK_URL = 'https://api-checkout.cinetpay.com/v2/payment/check';

const CINETPAY_API_KEY = process.env.CINETPAY_API_KEY;
const CINETPAY_SITE_ID = process.env.CINETPAY_SITE_ID;
const CINETPAY_SECRET_KEY = process.env.CINETPAY_SECRET_KEY;

const KAZAP_BASE_URL = process.env.KAZAP_BASE_URL || 'https://kazap-backend1.onrender.com';
const KAZAP_FRONTEND_URL = process.env.KAZAP_FRONTEND_URL || 'https://kazap.app';

// Statuts de paiement gérés (champ orders/{id}.paymentStatus)
const PAYMENT_STATUS = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED'
};

// ════════════════════════════════════════════════════════════════════════════
// Fonction utilitaire : mise à jour du statut de paiement d'une commande
// Met à jour Firestore (paymentStatus, paymentRef, history) et envoie le SMS
// de confirmation au client via Twilio en cas de succès.
// ════════════════════════════════════════════════════════════════════════════
async function updateOrderPaymentStatus(orderId, status, extra = {}) {
  if (!orderId || !status) {
    throw new Error('orderId et status sont requis');
  }
  if (!Object.values(PAYMENT_STATUS).includes(status)) {
    throw new Error(`Statut de paiement invalide : ${status}`);
  }

  const db = admin.firestore();
  const orderRef = db.collection('orders').doc(orderId);
  const snap = await orderRef.get();

  if (!snap.exists) {
    throw new Error(`Commande introuvable : ${orderId}`);
  }

  const order = snap.data();
  const hist = order.history || [];

  const labelMap = {
    PENDING: 'Paiement en attente',
    PAID: 'Paiement reçu ✅',
    FAILED: 'Paiement échoué ✗',
    REFUNDED: 'Paiement remboursé ↩️'
  };

  const histEntry = {
    status: `payment_${status.toLowerCase()}`,
    note: labelMap[status],
    changedBy: 'payment_system',
    changedByName: 'Système de paiement',
    timestamp: new Date().toISOString()
  };

  const updatePayload = {
    paymentStatus: status,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    history: [...hist, histEntry]
  };

  if (extra.paymentRef) updatePayload.paymentRef = extra.paymentRef;
  if (extra.operator) updatePayload.paymentOperator = extra.operator;
  if (extra.paidAt) updatePayload.paidAt = extra.paidAt;

  // Si le paiement est confirmé, on peut aussi faire avancer le statut métier
  // de la commande (sans écraser un statut déjà plus avancé : confirmed/shipped/etc.)
  if (status === PAYMENT_STATUS.PAID && order.status === 'pending') {
    updatePayload.status = 'confirmed';
  }

  await orderRef.update(updatePayload);

  // ── SMS de confirmation au client (uniquement si paiement réussi) ────────
  if (status === PAYMENT_STATUS.PAID && order.clientPhone) {
    try {
      await sendPaymentConfirmationSMS(order, extra);
    } catch (smsErr) {
      // Ne bloque jamais la mise à jour du statut si le SMS échoue
      console.warn('⚠️ SMS de confirmation paiement non envoyé :', smsErr.message);
    }
  }

  return { orderId, status, ...extra };
}

// ════════════════════════════════════════════════════════════════════════════
// SMS de confirmation de paiement via Twilio
// Récupère les credentials Twilio depuis Firestore vendors/:vendorId.voip
// (même logique que le backend existant), avec fallback sur variables d'env.
// ════════════════════════════════════════════════════════════════════════════
async function sendPaymentConfirmationSMS(order, extra = {}) {
  const db = admin.firestore();
  const vendorId = order.vendorId;
  const orderRef = order.orderId || extra.firestoreId || 'votre commande';
  const total = order.total || 0;

  let accountSid = process.env.TWILIO_ACCOUNT_SID;
  let authToken = process.env.TWILIO_AUTH_TOKEN;
  let fromNumber = process.env.TWILIO_FROM_NUMBER;
  let boutique = 'votre boutique';

  if (vendorId) {
    const vendorSnap = await db.collection('vendors').doc(vendorId).get();
    const vendorData = vendorSnap.data() || {};
    const voip = vendorData.voip || {};
    accountSid = voip.twilioAccountSid || accountSid;
    authToken = voip.twilioAuthToken || authToken;
    fromNumber = voip.number || fromNumber;
    boutique = vendorData.boutiqueName || boutique;
  }

  if (!accountSid || !authToken || !fromNumber) {
    console.warn('⚠️ Credentials Twilio manquants, SMS paiement non envoyé.');
    return;
  }

  const operatorLabel = extra.operator ? extra.operator.toUpperCase() : 'Mobile Money';

  const smsBody =
    `✅ KAZAP | Paiement reçu pour la commande #${orderRef} ` +
    `(${total.toLocaleString('fr-FR')} FCFA via ${operatorLabel}). ` +
    `Merci pour votre achat chez ${boutique} !`;

  const client = twilio(accountSid, authToken);
  await client.messages.create({
    body: smsBody,
    from: fromNumber,        // numéro Twilio approuvé Afrique (E.164)
    to: order.clientPhone    // format E.164 : +229..., +225..., +221...
  });

  console.log(`✅ SMS paiement envoyé à ${order.clientPhone} pour commande ${orderRef}`);
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/payment/initiate
// Crée une transaction de paiement CinetPay et renvoie l'URL de paiement.
//
// Body attendu :
//   {
//     operator: "cinetpay",
//     orderId: "<firestore_doc_id>",   // orders/{id}
//     orderRef: "KZ-XXXXXX",           // référence lisible (orderData.orderId)
//     amount: 5000,
//     currency: "XOF",
//     customerName: "Aminata Sossou",
//     customerPhone: "+22997000000",
//     vendorId: "<uid_vendeur>"
//   }
// ════════════════════════════════════════════════════════════════════════════
router.post('/initiate', async (req, res) => {
  try {
    const {
      operator,
      orderId,
      orderRef,
      amount,
      currency,
      customerName,
      customerPhone,
      vendorId
    } = req.body;

    // ── Validation des entrées ────────────────────────────────────────────
    if (!orderId || !amount || !customerPhone) {
      return res.status(400).json({
        error: 'orderId, amount et customerPhone sont requis'
      });
    }

    if (operator && operator !== 'cinetpay') {
      return res.status(400).json({
        error: `Opérateur "${operator}" non encore disponible. Seul CinetPay est actif en Phase 3.`
      });
    }

    if (!CINETPAY_API_KEY || !CINETPAY_SITE_ID) {
      return res.status(500).json({
        error: 'Configuration CinetPay manquante (CINETPAY_API_KEY / CINETPAY_SITE_ID).'
      });
    }

    // Vérifie que la commande existe bien dans Firestore avant de créer la
    // transaction (évite de générer des paiements orphelins)
    const db = admin.firestore();
    const orderSnap = await db.collection('orders').doc(orderId).get();
    if (!orderSnap.exists) {
      return res.status(404).json({ error: 'Commande introuvable.' });
    }

    // Identifiant de transaction unique (utilisé pour le webhook et la vérification)
    const transactionId = `KZP-${orderId}-${Date.now()}`;

    const payload = {
      apikey: CINETPAY_API_KEY,
      site_id: CINETPAY_SITE_ID,
      transaction_id: transactionId,
      amount: Math.round(Number(amount)),
      currency: currency || 'XOF',
      description: `Commande KAZAP ${orderRef || orderId}`,
      customer_name: customerName || 'Client KAZAP',
      customer_phone_number: customerPhone,
      notify_url: `${KAZAP_BASE_URL}/api/payment/webhook`,
      return_url: `${KAZAP_FRONTEND_URL}/?orderId=${orderId}&payment=return`,
      channels: 'ALL', // Orange Money, MTN, Moov, Wave, carte bancaire via CinetPay
      metadata: orderId, // renvoyé tel quel dans le webhook
      lang: 'fr'
    };

    const cinetpayRes = await axios.post(CINETPAY_API_URL, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });

    const data = cinetpayRes.data;

    if (!data || data.code !== '201' || !data.data || !data.data.payment_url) {
      console.error('Réponse CinetPay inattendue :', JSON.stringify(data));
      return res.status(502).json({
        error: 'Impossible d’initialiser le paiement CinetPay.',
        details: data && data.message
      });
    }

    // Enregistre la transaction en PENDING avec sa référence CinetPay
    await updateOrderPaymentStatus(orderId, PAYMENT_STATUS.PENDING, {
      paymentRef: transactionId,
      operator: 'cinetpay'
    });

    return res.json({
      success: true,
      paymentUrl: data.data.payment_url,
      transactionId
    });

  } catch (err) {
    console.error('POST /api/payment/initiate erreur :', err.message);
    return res.status(500).json({ error: 'Erreur serveur lors de l’initialisation du paiement.' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/payment/webhook
// Webhook de confirmation CinetPay.
//
// Sécurité : CinetPay envoie un champ `x-token` (HMAC SHA256) calculé à partir
// de la clé secrète + des données POST. La signature DOIT être vérifiée avant
// toute mise à jour de Firestore.
//
// Référence CinetPay : le token est un HMAC-SHA256 de la concaténation de
// certains champs de la notification, signé avec CINETPAY_SECRET_KEY.
// (cf. documentation CinetPay "Vérification de notification")
// ════════════════════════════════════════════════════════════════════════════
router.post('/webhook', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const receivedToken = req.headers['x-token'] || body.x_token || body.token;

    if (!CINETPAY_SECRET_KEY) {
      console.error('CINETPAY_SECRET_KEY manquante — webhook refusé.');
      return res.status(500).send('Configuration serveur invalide.');
    }

    // ── Vérification obligatoire de la signature ──────────────────────────
    const isValid = verifyCinetPaySignature(body, receivedToken, CINETPAY_SECRET_KEY);
    if (!isValid) {
      console.warn('⚠️ Signature webhook CinetPay invalide — requête ignorée.');
      return res.status(403).send('Signature invalide.');
    }

    const { cpm_trans_id, cpm_site_id, metadata } = body;
    const orderId = metadata; // on a passé orderId dans `metadata` lors de l'initiation

    if (!orderId) {
      console.warn('⚠️ Webhook CinetPay sans metadata/orderId.');
      return res.status(400).send('metadata (orderId) manquant.');
    }

    // ── Vérification du statut réel auprès de CinetPay (anti-rejeu) ───────
    const checkRes = await axios.post(CINETPAY_CHECK_URL, {
      apikey: CINETPAY_API_KEY,
      site_id: CINETPAY_SITE_ID || cpm_site_id,
      transaction_id: cpm_trans_id
    }, { timeout: 15000 });

    const checkData = checkRes.data;
    const cinetpayStatus = checkData && checkData.data && checkData.data.status; // "ACCEPTED" | "REFUSED" | ...

    let newStatus;
    if (cinetpayStatus === 'ACCEPTED') {
      newStatus = PAYMENT_STATUS.PAID;
    } else if (cinetpayStatus === 'REFUSED' || cinetpayStatus === 'CANCELLED') {
      newStatus = PAYMENT_STATUS.FAILED;
    } else {
      // Statut intermédiaire : on ne change rien, on accuse simplement réception
      console.log(`ℹ️ Webhook CinetPay statut intermédiaire (${cinetpayStatus}) pour ${orderId}`);
      return res.status(200).send('OK');
    }

    await updateOrderPaymentStatus(orderId, newStatus, {
      paymentRef: cpm_trans_id,
      operator: 'cinetpay',
      paidAt: newStatus === PAYMENT_STATUS.PAID
        ? admin.firestore.FieldValue.serverTimestamp()
        : null
    });

    console.log(`✅ Webhook CinetPay traité — commande ${orderId} → ${newStatus}`);
    return res.status(200).send('OK');

  } catch (err) {
    console.error('POST /api/payment/webhook erreur :', err.message);
    // On répond 200 quand même pour éviter que CinetPay ne réessaie en boucle
    // sur une erreur applicative (mais on log l'erreur côté serveur)
    return res.status(200).send('OK');
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/payment/status/:orderId
// Permet au frontend de vérifier l'état d'un paiement (ex. au retour de
// CinetPay sur la page boutique).
// ════════════════════════════════════════════════════════════════════════════
router.get('/status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const db = admin.firestore();
    const snap = await db.collection('orders').doc(orderId).get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Commande introuvable.' });
    }

    const order = snap.data();
    return res.json({
      orderId,
      paymentStatus: order.paymentStatus || PAYMENT_STATUS.PENDING,
      paymentRef: order.paymentRef || null,
      status: order.status || 'pending'
    });

  } catch (err) {
    console.error('GET /api/payment/status erreur :', err.message);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Vérification de la signature webhook CinetPay (HMAC SHA256)
//
// IMPORTANT : adapter l'ordre/le nom exact des champs concaténés selon la
// version d'API CinetPay utilisée (cf. doc officielle "Notification HTTP" —
// section "Calcul du x-token"). Le schéma ci-dessous suit le format standard
// HMAC-SHA256(secret_key, concat(champs_notification)).
// ════════════════════════════════════════════════════════════════════════════
function verifyCinetPaySignature(body, receivedToken, secretKey) {
  if (!receivedToken) return false;

  const fieldsOrder = [
    'cpm_site_id',
    'cpm_trans_id',
    'cpm_trans_date',
    'cpm_amount',
    'cpm_currency',
    'signature',
    'payment_method',
    'cel_phone_num',
    'cpm_phone_prefixe',
    'cpm_language',
    'cpm_version',
    'cpm_payment_config',
    'cpm_page_action',
    'cpm_custom',
    'cpm_designation',
    'cpm_error_message'
  ];

  const concatenated = fieldsOrder
    .map(field => (body[field] !== undefined && body[field] !== null) ? String(body[field]) : '')
    .join('');

  const expectedToken = crypto
    .createHmac('sha256', secretKey)
    .update(concatenated)
    .digest('hex');

  // Comparaison en temps constant pour éviter les attaques par timing
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedToken, 'utf8'),
      Buffer.from(String(receivedToken), 'utf8')
    );
  } catch {
    return false;
  }
}

module.exports = router;
module.exports.updateOrderPaymentStatus = updateOrderPaymentStatus;
module.exports.PAYMENT_STATUS = PAYMENT_STATUS;
