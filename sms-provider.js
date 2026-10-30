/**
 * KAZAP — sms-provider.js
 * Couche d'abstraction de l'envoi de SMS (Phase 6 du chantier appels dans l'application).
 *
 * Role : les nouveaux envois faits par le serveur (rappels de rendez-vous) passent par
 * ce module, qui choisit le fournisseur selon la variable d'environnement SMS_PROVIDER
 * ('twilio' par defaut). Les envois SMS deja existants dans server.js (/sms/send,
 * confirmations de commande, OTP) ne sont volontairement PAS modifies : ils continuent
 * d'appeler Twilio directement (zero regression). Ils pourront etre migres ici une fois
 * le fournisseur definitif choisi.
 *
 * Pour brancher un autre fournisseur (Vonage, fournisseur local, passerelle SMS Benin...) :
 *   1. ajouter une fonction dans PROVIDERS ci-dessous, de signature
 *        async ({ to, body, from, creds }) => ({ id })
 *      qui leve une erreur si l'envoi echoue ;
 *   2. definir SMS_PROVIDER=<nom> et les variables d'environnement propres au fournisseur sur Render.
 */

'use strict';

const NOM_FOURNISSEUR = String(process.env.SMS_PROVIDER || 'twilio').trim().toLowerCase();

/**
 * Fournisseur Twilio : utilise le client Twilio deja cree par server.js (injecte via
 * configurerTwilio) pour ne pas dupliquer les identifiants.
 */
let _clientTwilio = null;
function configurerTwilio(client) { _clientTwilio = client; }

const PROVIDERS = {
  twilio: async ({ to, body, from }) => {
    if (!_clientTwilio) throw new Error('Client Twilio non configure');
    const expediteur = from || process.env.TWILIO_PHONE_NUMBER;
    if (!expediteur) throw new Error('Numero Twilio non configure');
    const r = await _clientTwilio.messages.create({ body, from: expediteur, to });
    return { id: r && r.sid };
  }
  // Exemple a ajouter plus tard :
  // vonage: async ({ to, body, from }) => { ... return { id }; }
};

if (!PROVIDERS[NOM_FOURNISSEUR]) {
  console.warn(`[sms-provider] SMS_PROVIDER='${NOM_FOURNISSEUR}' inconnu. Fournisseurs disponibles : ${Object.keys(PROVIDERS).join(', ')}.`);
}

/** Envoie un SMS via le fournisseur configure. Leve une erreur explicite en cas d'echec. */
async function envoyerSMS({ to, body, from }) {
  const f = PROVIDERS[NOM_FOURNISSEUR];
  if (!f) throw new Error(`Fournisseur SMS '${NOM_FOURNISSEUR}' non configure`);
  if (!to || !body) throw new Error('Destinataire et message requis');
  return f({ to, body, from });
}

module.exports = { envoyerSMS, configurerTwilio, NOM_FOURNISSEUR };
