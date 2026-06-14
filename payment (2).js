/**
 * ════════════════════════════════════════════════════════════════════════════
 *  M-08 — MODULE PAIEMENT MOBILE MONEY — FedaPay
 *  Fichier : payment.js
 *  À monter dans le backend KAZAP existant (kazap-backend1, Express + firebase-admin)
 *
 *  Dépendances npm :
 *    npm install axios
 *    (firebase-admin et twilio déjà installés dans le backend)
 *
 *  Variables d'environnement requises :
 *    FEDAPAY_SECRET_KEY      — clé API secrète FedaPay (sk_live_... ou sk_sandbox_...)
 *    FEDAPAY_ENV             — "live" ou "sandbox" (défaut: "live")
 *    KAZAP_BASE_URL          — URL publique du backend (ex: https://kazap-backend1.onrender.com)
 *    KAZAP_FRONTEND_URL      — URL de la boutique publique (page de retour client)
 *    TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER — fallback SMS
 *
 *  Usage dans server.js existant :
 *    const paymentRouter = require('./payment');
 *    app.use('/api/payment', paymentRouter);
 *
 *  Flux FedaPay (2 étapes obligatoires) :
 *    1. POST /v1/transactions          → crée la transaction, retourne un id
 *    2. POST /v1/transactions/:id/token → génère le token + payment_url
 * ════════════════════════════════════════════════════════════════════════════
 */

const express = require('express');
const axios   = require('axios');
const admin   = require('firebase-admin'); // déjà initialisé dans le backend principal
const twilio  = require('twilio');

const router = express.Router();

// ────────────────────────────────────────────────────────────────────────────
// Configuration FedaPay
// ────────────────────────────────────────────────────────────────────────────
const FEDAPAY_ENV        = process.env.FEDAPAY_ENV || 'live';
const FEDAPAY_BASE_URL   = FEDAPAY_ENV === 'sandbox'
  ? 'https://sandbox-api.fedapay.com/v1'
  : 'https://api.fedapay.com/v1';
const FEDAPAY_SECRET_KEY = process.env.FEDAPAY_SECRET_KEY;

const KAZAP_BASE_URL     = process.env.KAZAP_BASE_URL     || 'https://kazap-backend1.onrender.com';
const KAZAP_FRONTEND_URL = process.env.KAZAP_FRONTEND_URL || 'https://kazap.app';

// En-têtes communs à toutes les requêtes FedaPay
function fedapayHeaders() {
  return {
    'Authorization': `Bearer ${FEDAPAY_SECRET_KEY}`,
    'Content-Type': 'application/json'
  };
}

// Statuts de paiement (champ Firestore orders/{id}.paymentStatus)
const PAYMENT_STATUS = {
  PENDING:  'PENDING',
  PAID:     'PAID',
  FAILED:   'FAILED',
  REFUNDED: 'REFUNDED'
};

// Correspondance statuts FedaPay → statuts KAZAP
// FedaPay renvoie : pending | approved | declined | transferred | refunded | canceled
const FEDAPAY_STATUS_MAP = {
  'approved':    PAYMENT_STATUS.PAID,
  'transferred': PAYMENT_STATUS.PAID,
  'declined':    PAYMENT_STATUS.FAILED,
  'canceled':    PAYMENT_STATUS.FAILED,
  'refunded':    PAYMENT_STATUS.REFUNDED,
  'pending':     PAYMENT_STATUS.PENDING
};

// ════════════════════════════════════════════════════════════════════════════
// Fonction utilitaire : mise à jour du statut de paiement dans Firestore
// ════════════════════════════════════════════════════════════════════════════
async function updateOrderPaymentStatus(orderId, status, extra = {}) {
  if (!orderId || !status) throw new Error('orderId et status sont requis');
  if (!Object.values(PAYMENT_STATUS).includes(status)) {
    throw new Error(`Statut de paiement invalide : ${status}`);
  }

  const db       = admin.firestore();
  const orderRef = db.collection('orders').doc(orderId);
  const snap     = await orderRef.get();

  if (!snap.exists) throw new Error(`Commande introuvable : ${orderId}`);

  const order = snap.data();
  const hist  = order.history || [];

  const labelMap = {
    PENDING:  'Paiement en attente ⏳',
    PAID:     'Paiement reçu ✅',
    FAILED:   'Paiement échoué ✗',
    REFUNDED: 'Paiement remboursé ↩️'
  };

  const histEntry = {
    status:        `payment_${status.toLowerCase()}`,
    note:          labelMap[status],
    changedBy:     'payment_system',
    changedByName: 'Système de paiement',
    timestamp:     new Date().toISOString()
  };

  const updatePayload = {
    paymentStatus: status,
    updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
    history:       [...hist, histEntry]
  };

  if (extra.paymentRef)  updatePayload.paymentRef      = extra.paymentRef;
  if (extra.operator)    updatePayload.paymentOperator  = extra.operator;
  if (extra.paidAt)      updatePayload.paidAt           = extra.paidAt;

  // Fait avancer le statut métier si la commande est encore en "pending"
  if (status === PAYMENT_STATUS.PAID && order.status === 'pending') {
    updatePayload.status = 'confirmed';
  }

  await orderRef.update(updatePayload);

  // SMS de confirmation (uniquement si paiement réussi)
  if (status === PAYMENT_STATUS.PAID && order.clientPhone) {
    try {
      await sendPaymentConfirmationSMS(order, extra);
    } catch (smsErr) {
      console.warn('⚠️ SMS paiement non envoyé :', smsErr.message);
    }
  }

  return { orderId, status, ...extra };
}

// ════════════════════════════════════════════════════════════════════════════
// SMS de confirmation de paiement via Twilio
// (même logique que le backend existant : credentials vendeur depuis Firestore)
// ════════════════════════════════════════════════════════════════════════════
async function sendPaymentConfirmationSMS(order, extra = {}) {
  const db       = admin.firestore();
  const vendorId = order.vendorId;
  const orderRef = order.orderId || 'votre commande';
  const total    = order.total   || 0;

  let accountSid = process.env.TWILIO_ACCOUNT_SID;
  let authToken  = process.env.TWILIO_AUTH_TOKEN;
  let fromNumber = process.env.TWILIO_FROM_NUMBER;
  let boutique   = 'votre boutique';

  if (vendorId) {
    const vendorSnap = await db.collection('vendors').doc(vendorId).get();
    const vendorData = vendorSnap.data() || {};
    const voip       = vendorData.voip   || {};
    accountSid       = voip.twilioAccountSid || accountSid;
    authToken        = voip.twilioAuthToken  || authToken;
    fromNumber       = voip.number           || fromNumber;
    boutique         = vendorData.boutiqueName || boutique;
  }

  if (!accountSid || !authToken || !fromNumber) {
    console.warn('⚠️ Credentials Twilio manquants — SMS paiement non envoyé.');
    return;
  }

  const smsBody =
    `✅ KAZAP | Paiement reçu pour la commande #${orderRef} ` +
    `(${total.toLocaleString('fr-FR')} FCFA via FedaPay). ` +
    `Merci pour votre achat chez ${boutique} !`;

  const client = twilio(accountSid, authToken);
  await client.messages.create({
    body: smsBody,
    from: fromNumber,
    to:   order.clientPhone
  });

  console.log(`✅ SMS paiement envoyé à ${order.clientPhone} pour commande ${orderRef}`);
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/payment/initiate
// Crée une transaction FedaPay (étape 1 + étape 2) et renvoie le payment_url.
//
// Body attendu :
//   {
//     operator: "fedapay",
//     orderId: "<firestore_doc_id>",
//     orderRef: "KZ-XXXXXX",
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
      orderId,
      orderRef,
      amount,
      currency,
      customerName,
      customerPhone,
      vendorId
    } = req.body;

    // ── Validation ────────────────────────────────────────────────────────
    if (!orderId || !amount || !customerPhone) {
      return res.status(400).json({
        error: 'orderId, amount et customerPhone sont requis'
      });
    }

    if (!FEDAPAY_SECRET_KEY) {
      return res.status(500).json({
        error: 'Configuration FedaPay manquante (FEDAPAY_SECRET_KEY).'
      });
    }

    // Vérifie que la commande existe dans Firestore
    const db        = admin.firestore();
    const orderSnap = await db.collection('orders').doc(orderId).get();
    if (!orderSnap.exists) {
      return res.status(404).json({ error: 'Commande introuvable.' });
    }

    // ── Étape 1 : créer la transaction FedaPay ────────────────────────────
    // Décompose le nom en prénom + nom (fallback si un seul mot)
    const nameParts = (customerName || 'Client KAZAP').trim().split(' ');
    const firstname = nameParts[0];
    const lastname  = nameParts.slice(1).join(' ') || 'KAZAP';

    const createPayload = {
      description:  `Commande KAZAP ${orderRef || orderId}`,
      amount:       Math.round(Number(amount)),
      currency:     { iso: currency || 'XOF' },
      callback_url: `${KAZAP_FRONTEND_URL}/?orderId=${orderId}&payment=return`,
      customer: {
        firstname,
        lastname,
        phone_number: {
          number:  customerPhone,
          country: 'BJ'       // Bénin par défaut ; FedaPay auto-détecte via préfixe
        }
      }
    };

    const createRes = await axios.post(
      `${FEDAPAY_BASE_URL}/transactions`,
      createPayload,
      { headers: fedapayHeaders(), timeout: 15000 }
    );

    const transaction    = createRes.data && createRes.data.v1 && createRes.data.v1.transaction;
    const transactionId  = transaction && transaction.id;

    if (!transactionId) {
      console.error('Réponse FedaPay inattendue (étape 1) :', JSON.stringify(createRes.data));
      return res.status(502).json({
        error: 'Impossible de créer la transaction FedaPay.'
      });
    }

    // ── Étape 2 : générer le token de paiement ────────────────────────────
    const tokenRes = await axios.post(
      `${FEDAPAY_BASE_URL}/transactions/${transactionId}/token`,
      {},
      { headers: fedapayHeaders(), timeout: 15000 }
    );

    const tokenData  = tokenRes.data  && tokenRes.data.v1;
    const paymentUrl = tokenData && tokenData.url;

    if (!paymentUrl) {
      console.error('Réponse FedaPay inattendue (étape 2) :', JSON.stringify(tokenRes.data));
      return res.status(502).json({
        error: 'Impossible de générer le lien de paiement FedaPay.'
      });
    }

    // Référence de paiement (préfixe KAZAP + id FedaPay)
    const paymentRef = `KZP-FP-${transactionId}`;

    // Enregistre la transaction en PENDING dans Firestore
    await updateOrderPaymentStatus(orderId, PAYMENT_STATUS.PENDING, {
      paymentRef,
      operator:      'fedapay',
      fedapayTxnId:  String(transactionId)
    });

    return res.json({
      success:       true,
      paymentUrl,
      transactionId: String(transactionId),
      paymentRef
    });

  } catch (err) {
    console.error('POST /api/payment/initiate erreur :', err.message);
    const fedaMsg = err.response && err.response.data && err.response.data.message;
    return res.status(500).json({
      error: fedaMsg || 'Erreur serveur lors de l\'initialisation du paiement.'
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/payment/webhook
// Webhook de confirmation FedaPay.
//
// FedaPay envoie un objet Event avec :
//   { name: "transaction.approved" | "transaction.declined" | ..., data: { transaction: {...} } }
//
// Sécurité : FedaPay ne signe pas les webhooks via HMAC (contrairement à
// Stripe/CinetPay). La vérification se fait en re-fetchant la transaction
// directement via l'API FedaPay pour confirmer son statut réel (anti-rejeu).
//
// URL à configurer dans le tableau de bord FedaPay → Webhooks :
//   https://kazap-backend1.onrender.com/api/payment/webhook
// ════════════════════════════════════════════════════════════════════════════
router.post('/webhook', express.json(), async (req, res) => {
  try {
    const body  = req.body || {};
    const event = body.name || ''; // ex: "transaction.approved"

    // On ne traite que les événements de transaction finaux
    const relevantEvents = [
      'transaction.approved',
      'transaction.transferred',
      'transaction.declined',
      'transaction.canceled',
      'transaction.refunded'
    ];

    if (!relevantEvents.includes(event)) {
      return res.status(200).send('OK');
    }

    const txnData       = body.data && body.data.transaction;
    const fedapayTxnId  = txnData && txnData.id;

    if (!fedapayTxnId) {
      console.warn('⚠️ Webhook FedaPay sans transaction.id — ignoré.');
      return res.status(400).send('transaction.id manquant.');
    }

    if (!FEDAPAY_SECRET_KEY) {
      console.error('FEDAPAY_SECRET_KEY manquante — webhook refusé.');
      return res.status(500).send('Configuration serveur invalide.');
    }

    // ── Vérification anti-rejeu : re-fetch du statut réel via l'API ───────
    const checkRes  = await axios.get(
      `${FEDAPAY_BASE_URL}/transactions/${fedapayTxnId}`,
      { headers: fedapayHeaders(), timeout: 15000 }
    );

    const confirmedTxn    = checkRes.data && checkRes.data.v1 && checkRes.data.v1.transaction;
    const fedapayStatus   = confirmedTxn && confirmedTxn.status;
    const kazapStatus     = FEDAPAY_STATUS_MAP[fedapayStatus];

    if (!kazapStatus || kazapStatus === PAYMENT_STATUS.PENDING) {
      console.log(`ℹ️ Webhook FedaPay statut intermédiaire (${fedapayStatus}) — ignoré.`);
      return res.status(200).send('OK');
    }

    // Retrouve la commande Firestore via la référence paymentRef (KZP-FP-<id>)
    const db          = admin.firestore();
    const paymentRef  = `KZP-FP-${fedapayTxnId}`;
    const ordersSnap  = await db.collection('orders')
      .where('paymentRef', '==', paymentRef)
      .limit(1)
      .get();

    if (ordersSnap.empty) {
      console.warn(`⚠️ Aucune commande trouvée pour paymentRef=${paymentRef}`);
      return res.status(200).send('OK'); // 200 pour éviter les retry FedaPay
    }

    const orderId = ordersSnap.docs[0].id;

    await updateOrderPaymentStatus(orderId, kazapStatus, {
      paymentRef,
      operator:     'fedapay',
      fedapayTxnId: String(fedapayTxnId),
      paidAt:       kazapStatus === PAYMENT_STATUS.PAID
        ? admin.firestore.FieldValue.serverTimestamp()
        : null
    });

    console.log(`✅ Webhook FedaPay traité — commande ${orderId} → ${kazapStatus}`);
    return res.status(200).send('OK');

  } catch (err) {
    console.error('POST /api/payment/webhook erreur :', err.message);
    // 200 pour éviter les retry infinis FedaPay sur erreur applicative
    return res.status(200).send('OK');
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/payment/status/:orderId
// Permet au frontend de vérifier le statut d'un paiement au retour de FedaPay.
// ════════════════════════════════════════════════════════════════════════════
router.get('/status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const db          = admin.firestore();
    const snap        = await db.collection('orders').doc(orderId).get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Commande introuvable.' });
    }

    const order = snap.data();
    return res.json({
      orderId,
      paymentStatus: order.paymentStatus || PAYMENT_STATUS.PENDING,
      paymentRef:    order.paymentRef    || null,
      status:        order.status        || 'pending'
    });

  } catch (err) {
    console.error('GET /api/payment/status erreur :', err.message);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
module.exports.updateOrderPaymentStatus = updateOrderPaymentStatus;
module.exports.PAYMENT_STATUS           = PAYMENT_STATUS;
