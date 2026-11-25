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

// ─────────────────────────────────────────────────────────────────────────────
// T-IA-RELIA-01 — Fiabilite des reponses IA (appels en particulier)
// ─────────────────────────────────────────────────────────────────────────────
//  1. Mesure : chaque tentative est journalisee avec sa duree (succes ou echec et cause exacte).
//  2. Nouvel essai : une erreur passagere (limite de requetes 429, erreur serveur 5xx, reseau) est
//     retentee une fois chez le meme fournisseur, seulement si elle est survenue vite.
//  3. Secours en parallele (appels seulement) : si le principal n'a pas repondu au bout de
//     AI_HEDGE_MS, le fournisseur de secours est lance SANS attendre l'echec complet du principal ;
//     la premiere reponse valide l'emporte. Evite d'attendre deux delais complets l'un apres l'autre.
const HEDGE_MS        = Number(process.env.AI_HEDGE_MS) || 3500;
const RETRY_PAUSE_MS  = 400;
const RETRY_MAX_DUREE = 2500;   // un echec plus lent que cela n'est pas retente (delai deja consomme)

function _erreurPassagere(err) {
  const m = String((err && err.message) || '');
  if (/Timeout/i.test(m)) return false;   // delai deja entierement consomme : le secours prend le relais
  return /HTTP (429|500|502|503|504)|injoignable|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket/i.test(m);
}
const _pause = (ms) => new Promise(r => setTimeout(r, ms));

/** Une tentative chez un fournisseur, avec mesure et un nouvel essai eventuel. */
async function _tenter(nom, nomFonction, options) {
  const f = PROVIDERS[nom];
  if (!f) throw new Error(`${nom} : fournisseur inconnu (disponibles : ${Object.keys(PROVIDERS).join(', ')})`);
  for (let essai = 1; ; essai++) {
    const t0 = Date.now();
    try {
      const resultat = await f[nomFonction](options);   // un resultat null (plan non autorise) ne declenche pas de bascule
      console.log(`[ai-provider] ${nom}/${nomFonction} OK en ${Date.now() - t0} ms${essai > 1 ? ` (essai ${essai})` : ''}`);
      return resultat;
    } catch (err) {
      const duree = Date.now() - t0;
      console.warn(`[ai-provider] ${nom}/${nomFonction} echec en ${duree} ms (essai ${essai}) : ${err && err.message}`);
      if (essai >= 2 || !_erreurPassagere(err) || duree > RETRY_MAX_DUREE) throw new Error(`${nom} : ${err && err.message}`);
      await _pause(RETRY_PAUSE_MS);
    }
  }
}

/** Voix : principal, puis secours lance en parallele des qu'il tarde ou echoue. Premiere reponse valide gagnante. */
function _executerCouvert(nomFonction, options, chaine) {
  return new Promise((resolve, reject) => {
    const erreurs = [];
    let fini = false, lances = 0, echecs = 0, minuteur = null;
    const terminer = (fn, v) => { if (fini) return; fini = true; clearTimeout(minuteur); fn(v); };
    const lancer = (idx) => {
      if (fini || idx >= chaine.length || lances > idx) return;
      lances = idx + 1;
      _tenter(chaine[idx], nomFonction, options).then(
        (res) => terminer(resolve, res),
        (err) => {
          erreurs.push(err && err.message);
          echecs++;
          if (idx === 0 && chaine.length > 1) console.warn('[ai-provider] principal en echec : bascule sur le fournisseur de secours');
          lancer(idx + 1);
          if (echecs >= chaine.length) terminer(reject, new Error(`IA indisponible - ${erreurs.join(' | ')}`));
        });
    };
    lancer(0);
    if (chaine.length > 1) minuteur = setTimeout(() => { console.warn(`[ai-provider] principal sans reponse apres ${HEDGE_MS} ms : secours lance en parallele`); lancer(1); }, HEDGE_MS);
  });
}

/** Essaie le fournisseur principal puis, en cas d'erreur, le fournisseur de secours. */
async function _executer(nomFonction, options) {
  const chaine = _chaine();
  if (nomFonction === 'genererReponseIA') return _executerCouvert(nomFonction, options, chaine);   // voix : latence critique
  const erreurs = [];
  for (const nom of chaine) {
    try {
      return await _tenter(nom, nomFonction, options);
    } catch (err) {
      erreurs.push(err && err.message);
      if (chaine.length > 1 && nom === chaine[0]) console.warn('[ai-provider] principal en echec : bascule sur le fournisseur de secours');
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
