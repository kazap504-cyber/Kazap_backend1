/**
 * KAZAP — ai-provider.js
 * Couche d'abstraction du modele d'IA (Phase 1), completee en Phase 8 : plusieurs
 * fournisseurs et bascule automatique en cas de panne.
 *
 * server.js et web-call.js passent par ce module, qui expose toujours les memes fonctions.
 *
 * Fournisseurs disponibles :
 *   gemini   Google Gemini        (GEMINI_API_KEY, GEMINI_MODEL optionnel)   voir llm-gemini.js
 *   mistral  Mistral              (MISTRAL_API_KEY, MISTRAL_MODEL optionnel) voir llm-mistral.js
 *   claude   Anthropic Claude     (ANTHROPIC_API_KEY)                         voir claude-agent.js
 *
 * Choix du fournisseur :
 *   AI_PROVIDER            fournisseur principal. Sans valeur : 'claude' si ANTHROPIC_API_KEY
 *                          existe (comportement historique), sinon 'gemini'.
 *   AI_FALLBACK_PROVIDER   fournisseur de secours, utilise si le principal echoue (cle absente,
 *                          panne, delai depasse). 'none' pour desactiver. Sans valeur : 'mistral'
 *                          si MISTRAL_API_KEY existe (et n'est pas deja le principal), sinon aucun.
 *
 * Pour ajouter un fournisseur : creer un module exposant complete({ system, messages,
 * maxTokens, timeoutMs }) -> texte, et l'ajouter dans PROVIDERS ci-dessous.
 */

'use strict';

const claude  = require('./claude-agent');
const llm     = require('./llm-agent');
const gemini  = require('./llm-gemini');
const mistral = require('./llm-mistral');
const boutiqueContext = require('./boutique-context');

const PROVIDERS = {
  claude,
  gemini:  llm.pourFournisseur(gemini),
  mistral: llm.pourFournisseur(mistral)
};

function _nomPrincipal() {
  const explicite = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (explicite) return explicite;
  return process.env.ANTHROPIC_API_KEY ? 'claude' : 'gemini';
}

function _nomSecours(principal) {
  const explicite = String(process.env.AI_FALLBACK_PROVIDER || '').trim().toLowerCase();
  if (explicite) return explicite === 'none' ? null : explicite;
  if (principal !== 'mistral' && process.env.MISTRAL_API_KEY) return 'mistral';
  if (principal !== 'gemini' && process.env.GEMINI_API_KEY) return 'gemini';
  return null;
}

function _chaine() {
  const principal = _nomPrincipal();
  const secours = _nomSecours(principal);
  return secours && secours !== principal ? [principal, secours] : [principal];
}

const PROVIDER_NAME = _nomPrincipal();
if (!PROVIDERS[PROVIDER_NAME]) {
  // Le serveur demarre quand meme ; l'erreur explicite est levee quand une reponse IA est demandee.
  console.warn(`[ai-provider] AI_PROVIDER='${PROVIDER_NAME}' inconnu. Fournisseurs disponibles : ${Object.keys(PROVIDERS).join(', ')}.`);
}

/** Essaie le fournisseur principal puis, en cas d'erreur, le fournisseur de secours. */
async function _executer(nomFonction, options) {
  const erreurs = [];
  for (const nom of _chaine()) {
    const f = PROVIDERS[nom];
    if (!f) { erreurs.push(`${nom} : fournisseur inconnu (disponibles : ${Object.keys(PROVIDERS).join(', ')})`); continue; }
    try {
      return await f[nomFonction](options);   // un resultat null (plan non autorise) n'declenche pas de bascule
    } catch (err) {
      erreurs.push(`${nom} : ${err && err.message}`);
      if (_chaine().length > 1 && nom === _chaine()[0]) console.warn(`[ai-provider] ${nom} en echec (${err && err.message}) : bascule sur le fournisseur de secours`);
    }
  }
  throw new Error(`IA indisponible - ${erreurs.join(' | ')}`);
}

/**
 * Ancrage sur la boutique reelle (T-IA-GROUND-01) : ajoute le catalogue lu dans la collection
 * "products" a une COPIE du document vendeur, pour tous les fournisseurs et pour le secours.
 * Sans identifiant de vendeur, ou si l'appelant a deja enrichi le document, les options sont
 * transmises telles quelles. Ne leve jamais d'erreur : en cas d'echec, le prompt indique que le
 * catalogue est inaccessible (voir claude-agent.js) au lieu de laisser le modele deviner.
 */
async function _enrichir(options) {
  try {
    const vd = options && options.vendeurData;
    if (vd && typeof vd._catalogueLu === 'boolean') return options;          // deja enrichi
    const id = (options && options.vendeurId) || (vd && (vd.uid || vd.vendorId));
    if (!id) return options;
    const vendeurData = await boutiqueContext.enrichirVendeurPourIA(id, vd);
    return Object.assign({}, options, { vendeurData });
  } catch (err) {
    console.warn('[ai-provider] Enrichissement du catalogue impossible :', err && err.message);
    return options;
  }
}

/** Reponse IA vocale (appel). Meme signature et meme retour que claude-agent.genererReponseIA. */
async function genererReponseIA(options) {
  return _executer('genererReponseIA', await _enrichir(options));
}

/** Reponse IA ecrite (messagerie). Meme signature et meme retour que claude-agent.genererReponseIAEcrit. */
async function genererReponseIAEcrit(options) {
  return _executer('genererReponseIAEcrit', await _enrichir(options));
}

module.exports = {
  genererReponseIA,
  genererReponseIAEcrit,
  // Elements communs, independants du modele
  construirePromptSysteme:      claude.construirePromptSysteme,
  construirePromptSystemeEcrit: claude.construirePromptSystemeEcrit,
  commandeEstComplete:          claude.commandeEstComplete,
  getIAWelcomeMsg:              claude.getIAWelcomeMsg,
  getIAWelcomeDtmf:             claude.getIAWelcomeDtmf,
  PROVIDER_NAME,
  _chaine
};
