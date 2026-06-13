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
    deepgramSocket:  null
  };

  // Charger les données du vendeur
  if (vendeurId) {
    try {
      const snap = await db.collection('vendors').doc(vendeurId).get();
      session.vendeurData = snap.exists ? snap.data() : null;
    } catch (e) {
      console.warn('⚠️ Impossible de charger les données vendeur :', e.message);
    }
  }

  // Initialiser Deepgram STT
  try {
    session.deepgramSocket = await traiterAudioStream({
      onTranscription: async (texte, isFinal) => {
        if (!texte || !isFinal) return;
        session.transcription += ' ' + texte;
        console.log(`📝 Transcription : "${texte.trim()}"`);
        if (session.reponseEnCours) return;
        session.reponseEnCours = true;

        try {
          const { reponse, type, details } = await genererReponseIA({
            transcription: session.transcription.trim(),
            vendeurData:   session.vendeurData
          });
          console.log(`🤖 Réponse IA [${type}] : "${reponse}"`);

          // Injecter la réponse vocale via l'API REST Twilio
          if (session.callSid) {
            await _injecterTwiML(session.callSid, reponse, vendeurId);
            await mettreAJourStatutAppel(session.callSid, {
              type, details,
              transcription: session.transcription.trim(),
              statut: 'ia_handled'
            });
          }

          // Créer l'ia_order si commande ou RDV détecté
          if (type === 'commande' || type === 'rdv') {
            await ecrireIaOrder({
              callSid:       session.callSid,
              vendeurId,
              type,
              statut:        'nouveau',
              client:        _extraireClient(details),
              details:       details?.resume || reponse,
              transcription: session.transcription.trim(),
              durationSec:   null
            });
            // Notification FCM au vendeur
            if (vendeurId) {
              const emoji = type === 'commande' ? '🛒' : '📅';
              const titre = type === 'commande' ? 'Nouvelle commande IA !' : 'Nouveau RDV IA !';
              await sendFCMPush(vendeurId, `${emoji} ${titre}`, details?.resume || reponse,
                { type, source: 'ia_vocal', clickUrl: '/dashboard?section=' + (type === 'rdv' ? 'agenda' : 'commandes') });
            }
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
          console.log(`▶️  Stream démarré — CallSid: ${session.callSid}`);
          break;
        case 'media':
          if (msg.media?.payload && session.deepgramSocket?.readyState === WebSocket.OPEN) {
            session.deepgramSocket.send(Buffer.from(msg.media.payload, 'base64'));
          }
          break;
        case 'stop':
          console.log(`⏹️  Stream arrêté — CallSid: ${session.callSid}`);
          if (session.deepgramSocket?.readyState === WebSocket.OPEN) session.deepgramSocket.close();
          break;
      }
    } catch (err) {
      console.error('❌ Erreur parsing WebSocket :', err.message);
    }
  });

  wsClient.on('close', () => {
    console.log(`🔌 WebSocket fermé — vendeurId: ${vendeurId}`);
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
    if (vendeurId) {
      const snap = await db.collection('vendors').doc(vendeurId).get();
      const voip = snap.data()?.voip || {};
      if (voip.twilioAccountSid && voip.twilioAuthToken) {
        accountSid = voip.twilioAccountSid;
        authToken  = voip.twilioAuthToken;
      }
    }
    const client = twilio(accountSid, authToken);
    const twiml  = new VoiceResponse();
    twiml.say({ language: 'fr-FR', voice: 'Polly.Lea' }, texte);
    const connect = twiml.connect();
    connect.stream({ url: `wss://kazap-backend1.onrender.com/media-stream/${vendeurId}` });
    await client.calls(callSid).update({ twiml: twiml.toString() });
    console.log(`🔊 TwiML injecté dans l'appel ${callSid}`);
  } catch (err) {
    console.error('❌ _injecterTwiML erreur :', err.message);
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
// DÉMARRAGE
// ════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 KAZAP Backend démarré sur le port ${PORT}`);
  console.log(`   URL : https://kazap-backend1.onrender.com`);
});

module.exports = { app, server };
