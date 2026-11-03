/**
 * KAZAP — llm-gemini.js
 * Fournisseur d'IA : Google Gemini (API generateContent, appel HTTP direct, sans SDK).
 *
 * Variables d'environnement :
 *   GEMINI_API_KEY   cle creee dans Google AI Studio (obligatoire)
 *   GEMINI_MODEL     modele (defaut : gemini-3.5-flash-lite)
 *
 * Remarques :
 *   - temperature / top_p ne sont volontairement pas envoyes : les modeles recents
 *     Flash-Lite refusent certaines valeurs personnalisees.
 *   - Le palier gratuit de Google peut reutiliser les echanges pour ameliorer ses modeles :
 *     il ne convient qu'aux tests avec des donnees fictives. En production, activer la
 *     facturation du projet Google Cloud (palier payant).
 */

'use strict';

const MODELE_PAR_DEFAUT = 'gemini-3.5-flash-lite';
const URL_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

/**
 * @param {{ system: string, messages: {role:'user'|'assistant', content:string}[], maxTokens: number, timeoutMs: number }} p
 * @returns {Promise<string>} texte genere
 */
async function complete({ system, messages, maxTokens, timeoutMs }) {
  const cle = process.env.GEMINI_API_KEY;
  if (!cle) throw new Error("Variable d'environnement GEMINI_API_KEY manquante");
  const modele = process.env.GEMINI_MODEL || MODELE_PAR_DEFAUT;

  const corps = {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    // Marge pour une eventuelle reflexion interne du modele (comptee dans les tokens de sortie)
    generationConfig: { maxOutputTokens: Math.max(maxTokens, 512) }
  };

  const ctrl = new AbortController();
  const minuteur = setTimeout(() => ctrl.abort(), timeoutMs);
  let reponse;
  try {
    reponse = await fetch(`${URL_BASE}${encodeURIComponent(modele)}:generateContent`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cle },
      body:    JSON.stringify(corps),
      signal:  ctrl.signal
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error(`Timeout Gemini (${Math.round(timeoutMs / 1000)}s)`);
    throw new Error(`Gemini injoignable : ${err && err.message}`);
  } finally {
    clearTimeout(minuteur);
  }

  if (!reponse.ok) {
    let detail = '';
    try { const j = await reponse.json(); detail = (j && j.error && j.error.message) || ''; } catch (e) { /* corps non JSON */ }
    throw new Error(`Gemini HTTP ${reponse.status}${detail ? ' : ' + String(detail).slice(0, 200) : ''}`);
  }

  const data = await reponse.json();
  const candidat = data && data.candidates && data.candidates[0];
  const parties = (candidat && candidat.content && candidat.content.parts) || [];
  // On ignore les parties de "reflexion" (thought) et on assemble le texte
  const texte = parties.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('');
  if (!texte.trim()) {
    const motif = (data && data.promptFeedback && data.promptFeedback.blockReason) || (candidat && candidat.finishReason) || 'reponse vide';
    throw new Error(`Reponse Gemini vide (${motif})`);
  }
  return texte;
}

module.exports = { complete, nom: 'gemini', MODELE_PAR_DEFAUT };
