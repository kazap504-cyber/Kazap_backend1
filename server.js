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
 *
 * ROUTES :
 *   POST /sms/send
 *   POST /otp/send
 *   POST /otp/verify
 *   GET  /api/voip/token
 *   POST /api/voip/incoming-call
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
 *   WS   /media-stream/:vendeurId ← IA Vocal M-01
 */

'use strict';

require('dotenv').config();

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const twilio    = require('twilio');
const admin     = require('firebase-admin');
const cors      = require('cors');

// ─── Modules internes IA Vocal M-01 ─────────────────────────────────────────
const { traiterAudioStream }                    = require('./deepgram');
const { genererReponseIA }                      = require('./claude-agent');
const { ecrireIaOrder, mettreAJourStatutAppel } = require('./firestore-writer');

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

// ─── Express + HTTP server ───────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status:  'ok',
  service: 'kazap-backend',
  version: '2.0.0'
}));

// ════════════════════════════════════════════════════════════════════════════
// SMS — Envoi de messages
// ════════════════════════════════════════════════════════════════════════════
app.post('/sms/send', async (req, res) => {
  const { vendorId, to, message } = req.body;
  if (!vendorId || !to || !message) {
    return res.status(400).json({ error: 'vendorId, to et message sont requis' });
  }
  try {
    const vendorSnap = await db.collection('vendors').doc(vendorId).get();
    if (!vendorSnap.exists) return res.status(404).json({ error: 'Vendor introuvable' });

    const vendor     = vendorSnap.data();
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

app.post('/otp/verify', async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'Données manquantes' });

  const key = 'otp_' + phone.replace(/\D/g, '');
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

    twiml.say({ language: 'fr-FR', voice: 'Polly.Celine' },
      'Bonjour, bienvenue sur KAZAP. Un instant, je vous mets en relation avec notre assistant.');
    twiml.dial(escapeXml(forwardNumber));
  } catch (err) {
    console.error('[VoIP Incoming] Erreur :', err);
    twiml.say({ language: 'fr-FR' }, 'Une erreur technique s\'est produite. Merci de rappeler.');
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
      return res.set('Content-Type', 'text/xml').send(`
        <Response><Say language="fr-FR">Ce numéro n'est pas configuré. Au revoir.</Say></Response>`);
    }

    const vendor = vendorSnap.data();
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
        return res.set('Content-Type', 'text/xml').send(`
          <Response><Say language="fr-FR">Le correspondant est momentanément indisponible. Au revoir.</Say></Response>`);
      }
      return res.set('Content-Type', 'text/xml').send(`
        <Response>
          <Dial timeout="20" action="${process.env.BACKEND_URL}/webhooks/twilio/${vendorId}/no-answer">
            <Number>${escapeXml(realNumber)}</Number>
          </Dial>
        </Response>`);
    }

    // ── Vendor INDISPONIBLE → IA DTMF ───────────────────────────
    const boutiqueName = vendor?.boutiqueName || 'notre boutique';
    const welcomeMsg   = vendor?.settings?.iaWelcomeMsg
      || `Bonjour et bienvenue chez ${boutiqueName}. Notre assistant virtuel vous répond.`;
    const backendUrl   = process.env.BACKEND_URL || '';

    return res.set('Content-Type', 'text/xml').send(`
      <Response>
        <Say language="fr-FR">${escapeXml(welcomeMsg)}</Say>
        <Gather numDigits="1" action="${backendUrl}/webhooks/twilio/${vendorId}/gather" method="POST" timeout="10">
          <Say language="fr-FR">Appuyez sur 1 pour connaître nos horaires, ou sur 2 pour laisser un message.</Say>
        </Gather>
        <Say language="fr-FR">Nous n'avons pas reçu votre choix. Merci de rappeler. Au revoir.</Say>
      </Response>`);
  } catch (err) {
    console.error('[Twilio] Erreur :', err);
    return res.set('Content-Type', 'text/xml').send(`
      <Response><Say language="fr-FR">Une erreur technique s'est produite. Merci de rappeler.</Say></Response>`);
  }
});

// ── Sans réponse (timeout transfert) ────────────────────────────
app.post('/webhooks/twilio/:vendorId/no-answer', (req, res) => {
  const { vendorId } = req.params;
  console.log(`[Twilio No-Answer] vendorId=${vendorId}`);
  return res.set('Content-Type', 'text/xml').send(`
    <Response>
      <Say language="fr-FR">Le correspondant n'est pas disponible pour le moment. Merci de rappeler. Au revoir.</Say>
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

    if (digit === '1') {
      const ranges = vendor?.settings?.availabilityRanges
        || [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }];
      const msg = `Nos horaires sont : matin de ${ranges[0]?.start} à ${ranges[0]?.end}`
        + (ranges[1] ? `, et après-midi de ${ranges[1].start} à ${ranges[1].end}` : '')
        + '. Au revoir.';
      return res.set('Content-Type', 'text/xml').send(`
        <Response><Say language="fr-FR">${escapeXml(msg)}</Say></Response>`);
    }

    if (digit === '2') {
      return res.set('Content-Type', 'text/xml').send(`
        <Response>
          <Say language="fr-FR">Vous pouvez laisser votre message après le bip. Appuyez sur dièse pour terminer.</Say>
          <Record maxLength="60" finishOnKey="#" action="${process.env.BACKEND_URL}/webhooks/twilio/${vendorId}/recording" />
          <Say language="fr-FR">Message enregistré. Merci et au revoir.</Say>
        </Response>`);
    }

    return res.set('Content-Type', 'text/xml').send(`
      <Response><Say language="fr-FR">Choix non reconnu. Au revoir.</Say></Response>`);
  } catch (err) {
    console.error('[Twilio Gather] Erreur :', err);
    return res.set('Content-Type', 'text/xml').send(`
      <Response><Say language="fr-FR">Erreur technique. Au revoir.</Say></Response>`);
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
  return res.set('Content-Type', 'text/xml').send(`
    <Response><Say language="fr-FR">Merci. Au revoir.</Say></Response>`);
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
      twiml.say({ language: 'fr-FR', voice: 'Polly.Lea' },
        'Désolé, ce service est temporairement indisponible. Veuillez rappeler ultérieurement.');
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    const vendeurSnap = await db.collection('vendors').doc(vendeurId).get();
    const vendeurData = vendeurSnap.data() || {};
    const iaEnabled   = vendeurData?.voip?.iaReceptionEnabled !== false;

    if (!iaEnabled) {
      const numeroRenvoi = vendeurData?.phone || vendeurData?.voip?.transferNumber;
      if (numeroRenvoi) {
        twiml.say({ language: 'fr-FR', voice: 'Polly.Lea' }, 'Veuillez patienter, nous transférons votre appel.');
        twiml.dial(numeroRenvoi);
      } else {
        twiml.say({ language: 'fr-FR', voice: 'Polly.Lea' },
          'Bonjour, nous ne pouvons pas répondre pour le moment. Merci de rappeler.');
      }
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    const msgAccueil = vendeurData?.settings?.iaWelcomeMsg
      || `Bonjour, je suis l'assistante de ${vendeurData?.boutiqueName || 'la boutique'}. Comment puis-je vous aider ?`;

    twiml.say({ language: 'fr-FR', voice: 'Polly.Lea' }, msgAccueil);
    const connect = twiml.connect();
    connect.stream({
      url:   `wss://kazap-backend1.onrender.com/media-stream/${vendeurId}`,
      track: 'inbound_track'
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
    twiml.say({ language: 'fr-FR', voice: 'Polly.Lea' },
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
        durationSec: CallDuration ? parseInt(CallDur
