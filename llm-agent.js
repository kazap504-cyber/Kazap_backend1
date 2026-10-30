/**
 * KAZAP — llm-agent.js
 * Agent IA generique (Phase 8) : memes entrees, memes sorties et memes regles que
 * claude-agent.js, mais le modele est un fournisseur interchangeable (Gemini, Mistral...).
 *
 * Ce module ne change RIEN aux prompts ni a l'extraction de l'intention : il reutilise
 * ceux de claude-agent.js (construirePromptSysteme, construirePromptSystemeEcrit,
 * _extraireIntention). Seul l'appel au modele differe.
 *
 *   pourFournisseur(fournisseur) -> { genererReponseIA, genererReponseIAEcrit }
 * ou fournisseur expose : async complete({ system, messages, maxTokens, timeoutMs }) -> texte
 */

'use strict';

const claude = require('./claude-agent');

// Reponses courtes (lues a voix haute) mais avec une marge pour le bloc JSON d'intention
const MAX_TOKENS_VOIX  = 600;
const MAX_TOKENS_ECRIT = 800;
const TIMEOUT_VOIX_MS  = Number(process.env.LLM_TIMEOUT_VOICE_MS)   || 6000;    // un appel ne peut pas attendre longtemps
const TIMEOUT_ECRIT_MS = Number(process.env.LLM_TIMEOUT_WRITTEN_MS) || 12000;

/**
 * Prepare l'historique pour une API de chat : roles alternes, commence par l'utilisateur.
 * (Les API Gemini et Mistral refusent ou deforment deux messages consecutifs du meme role.)
 */
function normaliserMessages(historique, messageUtilisateur) {
  const bruts = [
    ...historique.map(m => ({ role: m.role === 'ia' ? 'assistant' : 'user', content: String(m.texte || '') })),
    { role: 'user', content: messageUtilisateur }
  ].filter(m => m.content.trim());
  while (bruts.length && bruts[0].role === 'assistant') bruts.shift();
  const fusion = [];
  for (const m of bruts) {
    const dernier = fusion[fusion.length - 1];
    if (dernier && dernier.role === m.role) dernier.content += '\n' + m.content;
    else fusion.push({ role: m.role, content: m.content });
  }
  return fusion;
}

/** Retire d'un texte destine a la voix tout reste de bloc JSON d'intention (reponse tronquee). */
function nettoyerPourVoix(texte) {
  const idx = String(texte).search(/\{\s*"intention"/);
  return (idx >= 0 ? String(texte).slice(0, idx) : String(texte)).trim();
}

function pourFournisseur(fournisseur) {
  async function genererReponseIA({ transcription, vendeurData, historique = [], creneauxAgenda = null, lang = 'fr' }) {
    if (!transcription || !transcription.trim()) {
      const msgVide = lang === 'en'
        ? 'I didn\'t catch your message. Could you please repeat?'
        : 'Je n\'ai pas bien entendu votre message. Pouvez-vous répéter, s\'il vous plaît ?';
      return { reponse: msgVide, type: 'inconnu', details: { resume: lang === 'en' ? 'Empty or inaudible transcription' : 'Transcription vide ou inaudible' } };
    }
    const system = claude.construirePromptSysteme(vendeurData, creneauxAgenda, lang);
    const messages = normaliserMessages(historique, transcription.trim());
    const texteComplet = await fournisseur.complete({ system, messages, maxTokens: MAX_TOKENS_VOIX, timeoutMs: TIMEOUT_VOIX_MS });

    const { texteVocal, intention, details, statutCommande } = claude._extraireIntention(texteComplet);
    const reponse = nettoyerPourVoix(texteVocal) || nettoyerPourVoix(texteComplet);
    console.log(`[IA ${fournisseur.nom}/${lang}] type: ${intention} | statut_commande: ${statutCommande || 'n/a'} | reponse: "${reponse.substring(0, 80)}..."`);
    return { reponse, type: intention, details, statutCommande };
  }

  async function genererReponseIAEcrit({ message, vendeurData, historique = [], lang = 'fr', tonalite = null }) {
    // Meme controle de plan que claude-agent.js (import differe : evite la dependance circulaire avec server.js)
    const { _accesIAAutorise } = require('./server');
    if (!_accesIAAutorise(vendeurData)) {
      console.log('[messagerie IA] Acces IA non autorise pour ce plan : aucune reponse generee.');
      return null;
    }
    if (!message || !message.trim()) throw new Error('Message client vide');

    const system = claude.construirePromptSystemeEcrit(vendeurData, lang, tonalite);
    const messages = normaliserMessages(historique, message.trim());
    const texteComplet = await fournisseur.complete({ system, messages, maxTokens: MAX_TOKENS_ECRIT, timeoutMs: TIMEOUT_ECRIT_MS });

    const { texteVocal, intention, details, statutCommande } = claude._extraireIntention(texteComplet);
    const reponse = nettoyerPourVoix(texteVocal) || nettoyerPourVoix(texteComplet);
    console.log(`[IA ${fournisseur.nom}/messagerie/${lang}] type: ${intention} | reponse: "${reponse.substring(0, 80)}..."`);
    return { reponse, type: intention, details, statutCommande };
  }

  return { genererReponseIA, genererReponseIAEcrit };
}

module.exports = { pourFournisseur, normaliserMessages, nettoyerPourVoix };
