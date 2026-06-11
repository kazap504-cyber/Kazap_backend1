/**
 * KAZAP — Backend VoIP Twilio + OTP SMS + FCM Push Notifications
 *
 * Variables d'environnement requises sur Render :
 *   FIREBASE_ADMIN_KEY  → contenu JSON de firebase-admin-key.json (sur 1 ligne)
 *   BACKEND_URL         → https://kazap-backend.onrender.com
 *   TWILIO_ACCOUNT_SID  → Account SID Twilio (commence par AC...)
 *   TWILIO_AUTH_TOKEN   → Auth Token Twilio
 *   TWILIO_PHONE_NUMBER → Numéro Twilio au format E.164 (ex: +22961000000)
 */

const express = require('express');
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ── CORS ────────────────────────────────────────────────────────
const cors = require('cors');
app.use(cors());

// ── Firebase Admin ──────────────────────────────────────────────
const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_KEY);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── Twilio Client (VoIP + OTP SMS) ─────────────────────────────
const twilio = require('twilio');
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ── Health check ────────────────────────────────────────────────
app.get('/', (req, res) => res.send('Kazap backend OK'));

// ════════════════════════════════════════════════════════════════
// SMS — Envoi de messages (commandes, notifications, rappels RDV)
// ════════════════════════════════════════════════════════════════
app.post('/sms/send', async (req, res) => {
  const { vendorId, to, message } = req.body;
  if (!vendorId || !to || !message) {
    return res.status(400).json({ error: 'vendorId, to et message sont requis' });
  }

  try {
    const vendorSnap = await db.collection('vendors').doc(vendorId).get();
    if (!vendorSnap.exists) {
      return res.status(404).json({ error: 'Vendor introuvable' });
    }

    const vendor = vendorSnap.data();
    const fromNumber = vendor?.voip?.twilioPhoneNumber
                    || process.env.TWILIO_PHONE_NUMBER;

    if (!fromNumber) {
      return res.status(400).json({ error: 'Numéro Twilio non configuré' });
    }

    const result = await twilioClient.messages.create({
      body: message,
      from: fromNumber,
      to
    });

    return res.json({ success: true, sid: result.sid });
  } catch (err) {
    console.error('[SMS Send] Erreur :', err);
    return res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// OTP — Envoi et vérification par SMS (Twilio)
// ════════════════════════════════════════════════════════════════

app.post('/otp/send', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Numéro requis' });

  const code = String(Math.floor(1000 + Math.random() * 9000));
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
  const key = 'otp_' + phone.replace(/\D/g, '');

  try {
    // Stocker le code dans Firestore
    await db.collection('otp_codes').doc(key).set({
      code, expiresAt, phone,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Envoyer le SMS via Twilio
    await twilioClient.messages.create({
      body: `Votre code KAZAP : ${code} (valable 10 min)`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('[OTP Send] Erreur :', err);
    return res.status(500).json({ error: 'Erreur envoi OTP : ' + err.message });
  }
});

app.post('/otp/verify', async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'Données manquantes' });

  const key = 'otp_' + phone.replace(/\D/g, '');

  try {
    const snap = await db.collection('otp_codes').doc(key).get();
    if (!snap.exists) return res.status(400).json({ error: 'Code OTP introuvable. Renvoyez un nouveau code.' });

    const data = snap.data();
    if (Date.now() > data.expiresAt) return res.status(400).json({ error: 'Code OTP expiré. Renvoyez un nouveau code.' });
    if (data.code !== code) return res.status(400).json({ error: 'Code OTP incorrect.' });

    // Supprimer après vérification réussie
    await db.collection('otp_codes').doc(key).delete();

    return res.json({ success: true });
  } catch (err) {
    console.error('[OTP Verify] Erreur :', err);
    return res.status(500).json({ error: 'Erreur vérification OTP : ' + err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// TWILIO — APPEL ENTRANT
// ════════════════════════════════════════════════════════════════
app.post('/webhooks/twilio/:vendorId', async (req, res) => {
  const { vendorId } = req.params;
  const callerNumber = req.body.From || 'unknown';
  const sessionId    = req.body.CallSid || '';

  console.log(`[Twilio] vendorId=${vendorId} caller=${callerNumber} sid=${sessionId}`);

  try {
    const vendorSnap = await db.collection('vendors').doc(vendorId).get();

    if (!vendorSnap.exists) {
      return res.set('Content-Type', 'text/xml').send(`
        <Response>
          <Say language="fr-FR">Ce numéro n'est pas configuré. Au revoir.</Say>
        </Response>
      `);
    }

    const vendor = vendorSnap.data();

    // Enregistrer l'appel dans Firestore
    await db.collection('voip_calls').add({
      vendorId,
      callerNumber,
      sessionId,
      provider: 'twilio',
      iaHandled: !!vendor?.voip?.unavailableMode,
      startedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // ── Vendor DISPONIBLE → transférer l'appel ──────────────────
    if (!vendor?.voip?.unavailableMode) {
      const realNumber = vendor?.voip?.twilioForwardNumber
                      || vendor?.voip?.forwardNumber
                      || vendor?.phone;

      console.log(`[Twilio] Mode disponible → transfert vers ${realNumber}`);

      if (!realNumber) {
        return res.set('Content-Type', 'text/xml').send(`
          <Response>
            <Say language="fr-FR">Le correspondant est momentanément indisponible. Au revoir.</Say>
          </Response>
        `);
      }
      return res.set('Content-Type', 'text/xml').send(`
        <Response>
          <Dial timeout="20" action="${process.env.BACKEND_URL}/webhooks/twilio/${vendorId}/no-answer">
            <Number>${escapeXml(realNumber)}</Number>
          </Dial>
        </Response>
      `);
    }

    // ── Vendor INDISPONIBLE → L'IA prend l'appel ────────────────
    const boutiqueName = vendor?.boutiqueName || 'notre boutique';
    const welcomeMsg   = vendor?.settings?.iaWelcomeMsg
      || `Bonjour et bienvenue chez ${boutiqueName}. Notre assistant virtuel vous répond.`;

    const backendUrl = process.env.BACKEND_URL || '';

    return res.set('Content-Type', 'text/xml').send(`
      <Response>
        <Say language="fr-FR">${escapeXml(welcomeMsg)}</Say>
        <Gather numDigits="1" action="${backendUrl}/webhooks/twilio/${vendorId}/gather" method="POST" timeout="10">
          <Say language="fr-FR">Appuyez sur 1 pour connaître nos horaires, ou sur 2 pour laisser un message.</Say>
        </Gather>
        <Say language="fr-FR">Nous n'avons pas reçu votre choix. Merci de rappeler. Au revoir.</Say>
      </Response>
    `);

  } catch (err) {
    console.error('[Twilio] Erreur :', err);
    return res.set('Content-Type', 'text/xml').send(`
      <Response>
        <Say language="fr-FR">Une erreur technique s'est produite. Merci de rappeler.</Say>
      </Response>
    `);
  }
});

// ── Appel sans réponse (timeout transfert) ──────────────────────
app.post('/webhooks/twilio/:vendorId/no-answer', async (req, res) => {
  const { vendorId } = req.params;
  const dialStatus = req.body.DialCallStatus || '';

  console.log(`[Twilio No-Answer] vendorId=${vendorId} dialStatus=${dialStatus}`);

  return res.set('Content-Type', 'text/xml').send(`
    <Response>
      <Say language="fr-FR">Le correspondant n'est pas disponible pour le moment. Merci de rappeler ultérieurement. Au revoir.</Say>
    </Response>
  `);
});

// ── Traitement du choix DTMF ────────────────────────────────────
app.post('/webhooks/twilio/:vendorId/gather', async (req, res) => {
  const { vendorId } = req.params;
  const digit = req.body.Digits;

  console.log(`[Twilio Gather] vendorId=${vendorId} digit=${digit}`);

  try {
    const vendorSnap = await db.collection('vendors').doc(vendorId).get();
    const vendor = vendorSnap.data() || {};

    // Touche 1 → Horaires
    if (digit === '1') {
      const ranges = vendor?.settings?.availabilityRanges || [
        { start: '09:00', end: '12:00' },
        { start: '14:00', end: '18:00' }
      ];
      const msg = `Nos horaires sont : matin de ${ranges[0]?.start} à ${ranges[0]?.end}` +
        (ranges[1] ? `, et après-midi de ${ranges[1].start} à ${ranges[1].end}` : '') +
        '. Au revoir.';
      return res.set('Content-Type', 'text/xml').send(`
        <Response>
          <Say language="fr-FR">${escapeXml(msg)}</Say>
        </Response>
      `);
    }

    // Touche 2 → Laisser un message vocal
    if (digit === '2') {
      const backendUrl = process.env.BACKEND_URL || '';
      return res.set('Content-Type', 'text/xml').send(`
        <Response>
          <Say language="fr-FR">Vous pouvez laisser votre message après le bip. Appuyez sur dièse pour terminer.</Say>
          <Record maxLength="60" finishOnKey="#" action="${backendUrl}/webhooks/twilio/${vendorId}/recording" />
          <Say language="fr-FR">Message enregistré. Merci et au revoir.</Say>
        </Response>
      `);
    }

    // Choix non reconnu
    return res.set('Content-Type', 'text/xml').send(`
      <Response>
        <Say language="fr-FR">Choix non reconnu. Au revoir.</Say>
      </Response>
    `);

  } catch (err) {
    console.error('[Twilio Gather] Erreur :', err);
    return res.set('Content-Type', 'text/xml').send(`
      <Response>
        <Say language="fr-FR">Erreur technique. Au revoir.</Say>
      </Response>
    `);
  }
});

// ── Sauvegarde du message vocal ─────────────────────────────────
app.post('/webhooks/twilio/:vendorId/recording', async (req, res) => {
  const { vendorId } = req.params;
  const recordingUrl = req.body.RecordingUrl;
  const callerNumber = req.body.From || req.body.Caller || 'unknown';

  console.log(`[Twilio Recording] vendorId=${vendorId} url=${recordingUrl}`);

  try {
    await db.collection('voip_recordings').add({
      vendorId,
      callerNumber,
      recordingUrl,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {
    console.error('[Twilio Recording] Erreur Firestore :', err);
  }

  return res.set('Content-Type', 'text/xml').send(`
    <Response>
      <Say language="fr-FR">Merci. Au revoir.</Say>
    </Response>
  `);
});

// ── Helper ──────────────────────────────────────────────────────
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ════════════════════════════════════════════════════════════════
// FCM — PUSH NOTIFICATIONS (Firebase Cloud Messaging)
// ════════════════════════════════════════════════════════════════

/**
 * POST /api/save-fcm-token
 * Reçoit le FCM token du client (envoyé depuis le navigateur)
 * et le sauvegarde dans Firestore pour pouvoir envoyer des push notifications
 *
 * Body: { vendorId, token }
 */
app.post('/api/save-fcm-token', async (req, res) => {
  const { vendorId, token } = req.body;

  if (!vendorId || !token) {
    return res.status(400).json({
      error: 'Paramètres manquants : vendorId et token requis'
    });
  }

  try {
    // Mettre à jour le document vendor avec le nouveau token FCM
    await db.collection('vendors').doc(vendorId).update({
      fcmToken: token,
      fcmTokenUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`✅ FCM token sauvegardé pour vendor ${vendorId}`);
    return res.json({
      success: true,
      message: 'FCM token enregistré avec succès'
    });
  } catch (error) {
    console.error('[FCM Save Token] Erreur :', error);
    return res.status(500).json({
      error: `Erreur serveur : ${error.message}`
    });
  }
});

/**
 * Fonction utilitaire: sendFCMPush(vendorId, title, body, data)
 * Envoie une notification push FCM au vendor
 *
 * Exemple d'utilisation:
 *   await sendFCMPush(vendorId, "🛒 Nouvelle commande !", "Alice — 5 000 FCFA", {
 *     type: "order",
 *     tag: "kazap-orders",
 *     clickUrl: "/dashboard?section=commandes"
 *   });
 */
async function sendFCMPush(vendorId, title, body, data = {}) {
  try {
    // Récupérer le vendor et son FCM token
    const vendorDoc = await db.collection('vendors').doc(vendorId).get();

    if (!vendorDoc.exists) {
      console.warn(`⚠️ Vendor ${vendorId} introuvable`);
      return null;
    }

    const token = vendorDoc.data()?.fcmToken;
    if (!token) {
      console.warn(`⚠️ Aucun FCM token pour vendor ${vendorId}. Notifications push non disponibles.`);
      return null;
    }

    // Construire le message FCM
    const message = {
      token,
      notification: {
        title,
        body
      },
      data,
      webpush: {
        notification: {
          icon: 'https://votre-domaine.com/icons/icon-192x192.png',
          badge: 'https://votre-domaine.com/icons/icon-72x72.png',
          vibrate: [200, 100, 200]
        }
      }
    };

    // Envoyer via Firebase Admin Messaging
    const messageId = await admin.messaging().send(message);
    console.log(`✅ Push FCM envoyée (messageId: ${messageId}) → vendor ${vendorId}`);
    return messageId;
  } catch (error) {
    console.error(`❌ Erreur sendFCMPush pour vendor ${vendorId} :`, error.message);
    return null;
  }
}

/**
 * GET /test-fcm/:vendorId
 * Endpoint de test — envoie une notification push de test au vendor
 *
 * Exemple: GET https://kazap-backend1.onrender.com/test-fcm/USER_ID
 */
app.get('/test-fcm/:vendorId', async (req, res) => {
  const vendorId = req.params.vendorId;

  if (!vendorId) {
    return res.status(400).json({ error: 'vendorId requis' });
  }

  const messageId = await sendFCMPush(
    vendorId,
    '🧪 Test FCM',
    'Ceci est un message de test — si vous le lisez, FCM fonctionne ! ✅'
  );

  res.json({
    success: !!messageId,
    messageId,
    message: messageId
      ? 'Notification envoyée avec succès'
      : 'Erreur ou aucun token FCM disponible'
  });
});

// ════════════════════════════════════════════════════════════════
// EXEMPLES D'UTILISATION FCM (à ajouter dans vos routes)
// ════════════════════════════════════════════════════════════════

/*
 * EXEMPLE 1: Envoyer une notification push lors d'une NOUVELLE COMMANDE
 * À ajouter dans votre route POST /orders ou équivalent :
 *
 * app.post('/orders', async (req, res) => {
 *   // ... votre logique de création de commande ...
 *   const newOrder = {
 *     id: orderRef.id,
 *     vendorId: req.body.vendorId,
 *     clientName: req.body.clientName,
 *     clientPhone: req.body.clientPhone,
 *     total: req.body.total,
 *     status: 'pending',
 *     createdAt: admin.firestore.FieldValue.serverTimestamp()
 *   };
 *
 *   // Envoyer la push notification au vendor
 *   await sendFCMPush(
 *     newOrder.vendorId,
 *     '🛒 Nouvelle commande !',
 *     `${newOrder.clientName || 'Un client'} vient de passer une commande — ${Number(newOrder.total).toLocaleString('fr-FR')} FCFA`,
 *     {
 *       type: 'order',
 *       tag: 'kazap-orders',
 *       clickUrl: '/dashboard?section=commandes'
 *     }
 *   );
 *
 *   res.json({ success: true, order: newOrder });
 * });
 */

/*
 * EXEMPLE 2: Envoyer une notification push lors d'un NOUVEAU RDV
 * À ajouter dans votre route POST /appointments ou équivalent :
 *
 * app.post('/appointments', async (req, res) => {
 *   // ... votre logique de création de RDV ...
 *   const newAppt = {
 *     id: apptRef.id,
 *     vendorId: req.body.vendorId,
 *     clientName: req.body.clientName,
 *     date: req.body.date,
 *     time: req.body.time,
 *     status: 'pending',
 *     createdAt: admin.firestore.FieldValue.serverTimestamp()
 *   };
 *
 *   // Envoyer la push notification au vendor
 *   await sendFCMPush(
 *     newAppt.vendorId,
 *     '📅 Nouveau rendez-vous !',
 *     `${newAppt.clientName || 'Un client'} a pris RDV pour le ${newAppt.date} à ${newAppt.time}`,
 *     {
 *       type: 'rdv',
 *       tag: 'kazap-appointments',
 *       clickUrl: '/dashboard?section=agenda'
 *     }
 *   );
 *
 *   res.json({ success: true, appointment: newAppt });
 * });
 */

/*
 * EXEMPLE 3: Lister les FCM tokens sauvegardés (DEBUG)
 * GET /debug/fcm-tokens
 *
 * app.get('/debug/fcm-tokens', async (req, res) => {
 *   const vendorSnap = await db.collection('vendors').get();
 *   const tokens = [];
 *   vendorSnap.forEach(doc => {
 *     const token = doc.data().fcmToken;
 *     if (token) {
 *       tokens.push({ vendorId: doc.id, token: token.substring(0, 50) + '...' });
 *     }
 *   });
 *   res.json({ total: tokens.length, tokens });
 * });
 */

// ── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Kazap backend running on port ${PORT}`));
