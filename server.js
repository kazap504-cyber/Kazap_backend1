/**
 * KAZAP — Backend VoIP (Africa's Talking + Twilio)
 * Déployer sur Render, Railway, ou Fly.io
 *
 * Variables d'environnement requises :
 *   AT_API_KEY      → clé Africa's Talking
 *   AT_USERNAME     → sandbox
 *   FIREBASE_ADMIN_KEY → contenu JSON de firebase-admin-key.json (sur 1 ligne)
 *   BACKEND_URL     → https://kazap-backend.onrender.com
 */

const express = require('express');
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ── Africa's Talking SDK ────────────────────────────────────────
const AfricasTalking = require('africastalking');
const atClient = AfricasTalking({
  apiKey:   process.env.AT_API_KEY   || "atsk_1dbffddaa8e91ee0fcd35aaa76d586d4ec3a5b16b2887d55659b0c42cfad16d327861b0e",
  username: process.env.AT_USERNAME  || "sandbox"
});
const atVoice = atClient.VOICE;

// ── Firebase Admin ──────────────────────────────────────────────
const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_KEY);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();

// ── Health check ────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'Kazap VoIP Backend' }));

// ════════════════════════════════════════════════════════════════
// AFRICA'S TALKING — VOICE WEBHOOK
// Configurer dans AT Dashboard :
//   Voice → Sandbox App → Voice Callback URL
//   → https://VOTRE_URL/webhooks/voice/:vendorId
// ════════════════════════════════════════════════════════════════
app.post('/webhooks/voice/:vendorId', async (req, res) => {
  const { vendorId } = req.params;
  const { isActive, callerNumber, sessionId, dtmfDigits, callSessionState } = req.body;

  console.log(`[AT Voice] vendorId=${vendorId} caller=${callerNumber} session=${sessionId} state=${callSessionState}`);

  try {
    // Récupérer les données du vendor depuis Firestore
    const vendorSnap = await db.collection('vendors').doc(vendorId).get();
    if (!vendorSnap.exists) {
      return res.set('Content-Type', 'text/xml').send(`
        <Response>
          <Say>Ce numéro n'est pas configuré. Au revoir.</Say>
        </Response>
      `);
    }
    const vendor = vendorSnap.data();

    // ── Enregistrer l'appel dans Firestore ───────────────────
    await db.collection('voip_calls').add({
      vendorId,
      callerNumber: callerNumber || 'unknown',
      sessionId,
      provider: 'africas_talking',
      dtmfDigits: dtmfDigits || null,
      callSessionState: callSessionState || null,
      iaHandled: !!vendor?.voip?.unavailableMode,
      startedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // ── Vendor disponible → transférer l'appel ───────────────
    if (!vendor?.voip?.unavailableMode) {
      const realNumber = vendor.voip?.number || vendor.phone;
      if (!realNumber) {
        return res.set('Content-Type', 'text/xml').send(`
          <Response><Say>Le correspondant est momentanément indisponible.</Say></Response>
        `);
      }
      return res.set('Content-Type', 'text/xml').send(`
        <Response>
          <Dial phoneNumbers="${realNumber}" record="true" />
        </Response>
      `);
    }

    // ── Mode Indisponible → L'IA prend l'appel ───────────────
    const boutiqueName = vendor.boutiqueName || 'notre boutique';
    const welcomeMsg   = vendor.settings?.iaWelcomeMsg
      || `Bonjour et bienvenue chez ${boutiqueName}. Notre assistant IA vous répond.`;

    return res.set('Content-Type', 'text/xml').send(`
      <Response>
        <Say voice="en-US-Wavenet-A" playBeep="false">${escapeXml(welcomeMsg)}</Say>
        <GetDigits timeout="30" numDigits="1"
          callbackUrl="${process.env.BACKEND_URL || ''}/webhooks/voice/${vendorId}/digits">
          <Say>Appuyez sur 1 pour connaître nos horaires, 2 pour passer une commande, ou restez en ligne.</Say>
        </GetDigits>
        <Say>Nous n'avons pas reçu votre choix. Merci de rappeler. Au revoir.</Say>
      </Response>
    `);

  } catch (err) {
    console.error('[AT Voice] Erreur :', err);
    return res.set('Content-Type', 'text/xml').send(`
      <Response><Say>Une erreur technique s'est produite. Merci de rappeler.</Say></Response>
    `);
  }
});

// ── Traitement des touches DTMF ─────────────────────────────────
app.post('/webhooks/voice/:vendorId/digits', async (req, res) => {
  const { vendorId } = req.params;
  const { dtmfDigits, callerNumber } = req.body;

  console.log(`[AT Digits] vendorId=${vendorId} digit=${dtmfDigits} caller=${callerNumber}`);

  try {
    const vendorSnap = await db.collection('vendors').doc(vendorId).get();
    const vendor = vendorSnap.data() || {};

    if (dtmfDigits === '1') {
      const ranges = vendor.settings?.availabilityRanges || [
        { start: '09:00', end: '12:00' },
        { start: '14:00', end: '18:00' }
      ];
      const horaireMsg = `Nos horaires sont : matin de ${ranges[0]?.start} à ${ranges[0]?.end}` +
        (ranges[1] ? `, et après-midi de ${ranges[1].start} à ${ranges[1].end}` : '') + '. Au revoir.';
      return res.set('Content-Type', 'text/xml').send(`
        <Response><Say>${escapeXml(horaireMsg)}</Say></Response>
      `);
    }

    if (dtmfDigits === '2') {
      return res.set('Content-Type', 'text/xml').send(`
        <Response>
          <Say>Pour passer une commande, veuillez nous envoyer un message WhatsApp ou rappeler pendant nos heures d'ouverture. Au revoir.</Say>
        </Response>
      `);
    }

    return res.set('Content-Type', 'text/xml').send(`
      <Response><Say>Choix non reconnu. Au revoir.</Say></Response>
    `);
  } catch (err) {
    console.error('[AT Digits] Erreur :', err);
    return res.set('Content-Type', 'text/xml').send(`
      <Response><Say>Erreur technique. Au revoir.</Say></Response>
    `);
  }
});

// ════════════════════════════════════════════════════════════════
// TWILIO — VOICE WEBHOOK (optionnel)
// ════════════════════════════════════════════════════════════════
app.post('/webhooks/twilio/:vendorId', async (req, res) => {
  const { vendorId } = req.params;
  const { From: callerNumber, CallSid: sessionId } = req.body;

  try {
    const vendorSnap = await db.collection('vendors').doc(vendorId).get();
    const vendor = vendorSnap.data() || {};

    await db.collection('voip_calls').add({
      vendorId, callerNumber, sessionId,
      provider: 'twilio',
      iaHandled: !!vendor?.voip?.unavailableMode,
      startedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    if (!vendor?.voip?.unavailableMode) {
      return res.set('Content-Type', 'text/xml').send(
        `<Response><Dial>${vendor.phone}</Dial></Response>`
      );
    }

    const welcomeMsg = vendor.settings?.iaWelcomeMsg || 'Bonjour, notre assistant virtuel vous répond.';
    return res.set('Content-Type', 'text/xml').send(`
      <Response>
        <Say language="fr-FR">${escapeXml(welcomeMsg)}</Say>
        <Gather numDigits="1" action="/webhooks/twilio/${vendorId}/gather">
          <Say language="fr-FR">Tapez 1 pour les horaires, 2 pour une commande.</Say>
        </Gather>
      </Response>
    `);
  } catch (err) {
    console.error('[Twilio] Erreur :', err);
    return res.set('Content-Type', 'text/xml').send(
      `<Response><Say language="fr-FR">Erreur technique.</Say></Response>`
    );
  }
});

// ── Helpers ─────────────────────────────────────────────────────
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Start server ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Kazap VoIP backend running on port ${PORT}`));
