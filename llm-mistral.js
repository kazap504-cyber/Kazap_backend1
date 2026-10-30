/**
 * KAZAP — llm-mistral.js
 * Fournisseur d'IA : Mistral (API de chat compatible OpenAI, appel HTTP direct, sans SDK).
 *
 * Variables d'environnement :
 *   MISTRAL_API_KEY  cle creee dans la console Mistral (obligatoire)
 *   MISTRAL_MODEL    modele (defaut : mistral-small-latest)
 *
 * Remarque : le palier gratuit (Experiment) exige d'accepter l'utilisation des donnees
 * pour l'entrainement des modeles : tests avec donnees fictives uniquement.
 */

'use strict';

const MODELE_PAR_DEFAUT = 'mistral-small-latest';
const URL_API = 'https://api.mistral.ai/v1/chat/completions';

async function complete({ system, messages, maxTokens, timeoutMs }) {
  const cle = process.env.MISTRAL_API_KEY;
  if (!cle) throw new Error("Variable d'environnement MISTRAL_API_KEY manquante");

  const corps = {
    model: process.env.MISTRAL_MODEL || MODELE_PAR_DEFAUT,
    max_tokens: Math.max(maxTokens, 512),
    messages: [{ role: 'system', content: system }, ...messages.map(m => ({ role: m.role, content: m.content }))]
  };

  const ctrl = new AbortController();
  const minuteur = setTimeout(() => ctrl.abort(), timeoutMs);
  let reponse;
  try {
    reponse = await fetch(URL_API, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cle}` },
      body:    JSON.stringify(corps),
      signal:  ctrl.signal
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error(`Timeout Mistral (${Math.round(timeoutMs / 1000)}s)`);
    throw new Error(`Mistral injoignable : ${err && err.message}`);
  } finally {
    clearTimeout(minuteur);
  }

  if (!reponse.ok) {
    let detail = '';
    try { const j = await reponse.json(); detail = (j && (j.message || (j.error && j.error.message))) || ''; } catch (e) { /* corps non JSON */ }
    throw new Error(`Mistral HTTP ${reponse.status}${detail ? ' : ' + String(detail).slice(0, 200) : ''}`);
  }

  const data = await reponse.json();
  const contenu = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  // Le contenu est une chaine, ou une liste de blocs { type:'text', text } selon le modele
  const texte = Array.isArray(contenu)
    ? contenu.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('')
    : (typeof contenu === 'string' ? contenu : '');
  if (!texte.trim()) throw new Error('Reponse Mistral vide');
  return texte;
}

module.exports = { complete, nom: 'mistral', MODELE_PAR_DEFAUT };
