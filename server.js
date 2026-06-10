/**
 * KAZAP — Backend VoIP Twilio
 *
 * Variables d'environnement requises sur Render :
 *   FIREBASE_ADMIN_KEY → contenu JSON de firebase-admin-key.json (sur 1 ligne)
 *   BACKEND_URL        → https://kazap-backend1.onrender.com
 */

const express = require('express');
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ── Firebase Admin ──────────────────────────────────────────────
const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_KEY);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── Health check ────────────────────────────────────────────────
app.get('/', (req, res) => res.send('Kazap backend OK'));

// ════════════════════════════════════════════════════════════════
// TWILIO — APPEL ENTRANT
// Configurer dans Twilio Console :
//   Phone Number → Voice → Webhook URL
//   → https://kazap-backend1.onrender.com/webhooks/twilio/VENDOR_ID
// ════════════════════════════════════════════════════════════════
app.post('/webhooks/twilio/:vendorId', async (req, res) => {
  const { vendorId } = req.params;
  const callerNumber = req.body.From || 'unknown';
  const sessionId    = req.body.CallSid || '';

  console.log(`[Twilio] vendorId=${vendorId} caller=${callerNumber} sid=${sessionId}`);

  try {
    // Récupérer les données du vendor dans Firestore
    const vendorSnap = await db.collection('vendors').doc(vendorId).get();

    if (!vendorSnap.exists) {
      return res.set('Content-Type', 'text/xml').send(`
        <Response>
          <Say language="fr-FR">Ce numéro n'est pas configuré. Au revoir.</Say>
        </Response>
      `);
    }

    const vendor = vendorSnap.data();

    // Enregistrer l'appel dans Firestore (collection voip_calls)
    await db.collection('voip_calls').add({
      vendorId,
      callerNumber,
      sessionId,
      provider: 'twilio',
      iaHandled: !!vendor?.voip?.unavailableMode,
      startedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // ── Vendor DISPONIBLE → transférer l'appel sur son vrai numéro ──
    if (!vendor?.voip?.unavailableMode) {
      const realNumber = vendor?.voip?.number || vendor?.phone;
      if (!realNumber) {
        return res.set('Content-Type', 'text/xml').send(`
          <Response>
            <Say language="fr-FR">Le correspondant est momentanément indisponible. Au revoir.</Say>
          </Response>
        `);
      }
      return res.set('Content-Type', 'text/xml').send(`
        <Response>
          <Dial>${escapeXml(realNumber)}</Dial>
        </Response>
      `);
    }

    // ── Vendor INDISPONIBLE → L'IA prend l'appel ─────────────────
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

// ── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Kazap backend running on port ${PORT}`));
