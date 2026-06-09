require("dotenv").config();
const express = require("express");
const admin = require("firebase-admin");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── Firebase Admin Init ────────────────────────────────────────
// Le fichier firebase-admin-key.json doit être dans le même dossier
// (il est exclu du repo via .gitignore)
const serviceAccount = require("./firebase-admin-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: "kazap-f8ff6",
});

const db = admin.firestore();
const VoiceResponse = twilio.twiml.VoiceResponse;

// ── Helpers ────────────────────────────────────────────────────

// Récupère les données du vendeur depuis Firestore
async function getVendor(vendorId) {
  const snap = await db.collection("vendors").doc(vendorId).get();
  return snap.exists ? snap.data() : null;
}

// Formate un numéro local béninois en E.164 (+229...)
function toE164(num) {
  if (!num) return null;
  const clean = num.replace(/\D/g, "");
  if (clean.startsWith("229")) return "+" + clean;
  if (clean.length === 8) return "+229" + clean;
  return "+" + clean;
}

// Vérifie si on est dans les heures d'ouverture du vendeur
function isWithinHours(vendor) {
  if (!vendor.hoursEnabled) return true; // pas de filtre = toujours ouvert
  const now = new Date();
  const day = now.toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
  const hours = vendor.openHours && vendor.openHours[day];
  if (!hours || !hours.open) return false;
  const [oh, om] = hours.start.split(":").map(Number);
  const [ch, cm] = hours.end.split(":").map(Number);
  const nowMins = now.getHours() * 60 + now.getMinutes();
  return nowMins >= oh * 60 + om && nowMins < ch * 60 + cm;
}

// ── Route : ping de santé ──────────────────────────────────────
app.get("/", (req, res) => {
  res.send("Kazap backend OK");
});

// ── Route principale : appel entrant Twilio ────────────────────
// Twilio appelle cette URL dès qu'un client compose le numéro du vendeur.
// Logique :
//   • Mode "vendeur disponible" ET dans les heures → transfert direct
//   • Sinon → menu IA (Appuyez sur 1 pour les horaires, 2 pour une commande…)
app.post("/webhooks/twilio/:vendorId", async (req, res) => {
  const { vendorId } = req.params;
  const twiml = new VoiceResponse();

  try {
    const vendor = await getVendor(vendorId);

    if (!vendor) {
      twiml.say({ language: "fr-FR" }, "Boutique introuvable. Au revoir.");
      return res.type("text/xml").send(twiml.toString());
    }

    const voipMode = vendor.voipMode || "ia"; // "vendor" | "ia"
    const withinHours = isWithinHours(vendor);

    if (voipMode === "vendor" && withinHours && vendor.phone) {
      // ── Transfert direct au vendeur ──
      const dial = twiml.dial({
        action: `/webhooks/twilio/${vendorId}/dialstatus`,
        method: "POST",
        timeout: 20,
        callerId: req.body.From || vendor.twilioNumber,
      });
      dial.number(toE164(vendor.phone));
    } else {
      // ── Menu IA ──
      const shopName = vendor.shopName || "cette boutique";
      const gather = twiml.gather({
        numDigits: 1,
        action: `/webhooks/twilio/${vendorId}/gather`,
        method: "POST",
        timeout: 8,
        language: "fr-FR",
      });
      gather.say(
        { language: "fr-FR", voice: "Polly.Celine" },
        `Bonjour et bienvenue chez ${shopName}. ` +
          `Appuyez sur 1 pour connaître nos horaires d'ouverture. ` +
          `Appuyez sur 2 pour passer une commande. ` +
          `Appuyez sur 0 pour laisser un message.`
      );
      // Si aucune touche appuyée
      twiml.say(
        { language: "fr-FR" },
        "Nous n'avons pas reçu votre choix. Rappellez-nous. Au revoir."
      );
      twiml.hangup();
    }
  } catch (err) {
    console.error("Erreur webhook principal :", err);
    twiml.say({ language: "fr-FR" }, "Une erreur technique est survenue. Au revoir.");
  }

  res.type("text/xml").send(twiml.toString());
});

// ── Route gather : réponse aux touches DTMF ───────────────────
app.post("/webhooks/twilio/:vendorId/gather", async (req, res) => {
  const { vendorId } = req.params;
  const digit = req.body.Digits;
  const twiml = new VoiceResponse();

  try {
    const vendor = await getVendor(vendorId);
    const shopName = vendor ? vendor.shopName || "la boutique" : "la boutique";

    if (digit === "1") {
      // Horaires d'ouverture
      let hoursText = "Nous sommes ouverts du lundi au samedi de 8h à 18h.";
      if (vendor && vendor.hoursText) hoursText = vendor.hoursText;
      twiml.say({ language: "fr-FR", voice: "Polly.Celine" }, hoursText);
      twiml.say({ language: "fr-FR" }, "Merci de votre appel. À bientôt !");
      twiml.hangup();

    } else if (digit === "2") {
      // Commande vocale
      twiml.say(
        { language: "fr-FR", voice: "Polly.Celine" },
        `Pour passer une commande chez ${shopName}, veuillez nous envoyer un message ` +
          `WhatsApp ou rappeler pendant nos heures d'ouverture. Merci !`
      );
      twiml.hangup();

    } else if (digit === "0") {
      // Message vocal (enregistrement)
      twiml.say(
        { language: "fr-FR", voice: "Polly.Celine" },
        "Après le bip, laissez votre message. Appuyez sur dièse pour terminer."
      );
      twiml.record({
        action: `/webhooks/twilio/${vendorId}/recording`,
        method: "POST",
        finishOnKey: "#",
        maxLength: 60,
        transcribe: false,
      });

    } else {
      twiml.say(
        { language: "fr-FR" },
        "Touche non reconnue. Au revoir."
      );
      twiml.hangup();
    }
  } catch (err) {
    console.error("Erreur gather :", err);
    twiml.say({ language: "fr-FR" }, "Erreur technique. Au revoir.");
    twiml.hangup();
  }

  res.type("text/xml").send(twiml.toString());
});

// ── Route dialstatus : fin du transfert au vendeur ─────────────
// Appelée par Twilio après la tentative de transfert.
// Si le vendeur ne répond pas → message d'absence.
app.post("/webhooks/twilio/:vendorId/dialstatus", async (req, res) => {
  const { vendorId } = req.params;
  const dialStatus = req.body.DialCallStatus; // "completed" | "no-answer" | "busy" | "failed"
  const twiml = new VoiceResponse();

  try {
    const vendor = await getVendor(vendorId);
    const shopName = vendor ? vendor.shopName || "la boutique" : "la boutique";

    if (dialStatus !== "completed") {
      // Vendeur n'a pas répondu
      const absenceMsg =
        vendor && vendor.absenceMessage
          ? vendor.absenceMessage
          : `Désolé, ${shopName} est momentanément indisponible. ` +
            `Envoyez-nous un message WhatsApp ou rappelez plus tard. Merci !`;

      twiml.say({ language: "fr-FR", voice: "Polly.Celine" }, absenceMsg);
    }
  } catch (err) {
    console.error("Erreur dialstatus :", err);
  }

  twiml.hangup();
  res.type("text/xml").send(twiml.toString());
});

// ── Route recording (bonus) ────────────────────────────────────
app.post("/webhooks/twilio/:vendorId/recording", (req, res) => {
  // Twilio envoie l'URL de l'enregistrement — on peut le stocker en Firestore si besoin
  console.log("Enregistrement reçu :", req.body.RecordingUrl);
  const twiml = new VoiceResponse();
  twiml.say({ language: "fr-FR" }, "Message bien reçu. Merci et à bientôt !");
  twiml.hangup();
  res.type("text/xml").send(twiml.toString());
});

// ── Démarrage ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Kazap backend démarré sur le port ${PORT}`);
});
