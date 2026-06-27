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
 *   POST /uptime-alert           ← T-07-C Webhook downtime UptimeRobot → SMS admin
 *   POST /webhook/fedapay        ← T-07-F Webhook FedaPay → activation plan vendeur
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
const { traiterAudioStream }                    = require('./deepgram');
const { genererReponseIA, commandeEstComplete } = require('./claude-agent');
const { ecrireIaOrder, mettreAJourStatutAppel } = require('./firestore-writer');
const { getCreneauxPourIA }                     = require('./agenda-reader'); // Agenda temps réel
const RdvBooking                                = require('./rdv-booking');     // Prise de RDV (M-04)
const paymentRouter                             = require('./payment');         // M-08 — Paiement Mobile Money

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

    await db.collection('vendors').doc(uid).set({
      twilioNumber: purchased.phoneNumber,
      email: email || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    console.log(`✅ Numéro provisionné ${purchased.phoneNumber} pour ${uid}`);
    return res.json({ success: true, phoneNumber: purchased.phoneNumber });

  } catch (err) {
    console.error('[provision-number] Erreur :', err.message);
    return res.status(500).json({ error: err.message });
  }
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
    const period     = meta.period     || 'monthly';
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
    const now        = new Date();
    let   expiration = new Date(now);

    if (period === 'annual' || period === 'yearly' || period === 'year') {
      expiration.setFullYear(expiration.getFullYear() + 1);
    } else {
      // Par défaut : mensuel
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

module.exports = { app, server };
