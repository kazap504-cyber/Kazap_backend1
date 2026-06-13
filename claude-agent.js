/**
 * KAZAP — claude-agent.js
 * Module IA : appel à l'API Claude Anthropic.
 *
 * Rôle :
 *   - Construire le prompt système KAZAP à partir des données du vendeur
 *   - Détecter l'intention du client (commande / rdv / info / inconnu)
 *   - Générer une réponse en français adaptée au contexte de la boutique
 *   - Retourner la réponse + le type d'intention + les détails structurés
 *
 * Modèle utilisé : claude-sonnet-4-6 (performant, rapide, économique)
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');

// Délai maximum pour la réponse Claude (15 secondes)
const CLAUDE_TIMEOUT_MS = 15_000;

// Nombre maximum de tokens pour la réponse (garder court pour le TTS)
const MAX_TOKENS = 300;

/**
 * Construire le prompt système KAZAP à partir des données du vendeur.
 * Ce prompt est le cœur de l'IA vocale.
 *
 * @param {Object} vendeurData — Document Firestore du vendeur (collection vendors)
 * @returns {string} — Prompt système complet
 */
function construirePromptSysteme(vendeurData) {
  const boutique   = vendeurData?.boutiqueName   || 'la boutique';
  const prenom     = vendeurData?.prenom         || '';
  const produits   = vendeurData?.products       || [];
  const faq        = vendeurData?.settings?.iaFAQ || [];
  const localisation = vendeurData?.localisation || null;
  const description  = vendeurData?.description  || vendeurData?.category || null;

  // Section FAQ dynamique
  let sectionFAQ = '';
  if (faq.length > 0) {
    sectionFAQ = `\n\nQuestions fréquentes de cette boutique :\n` +
      faq.map(f => `Q: ${f.q}\nR: ${f.r}`).join('\n\n');
  }

  // Section produits (si disponibles)
  let sectionProduits = '';
  if (Array.isArray(produits) && produits.length > 0) {
    const listeProduits = produits
      .filter(p => p.isAvailable !== false && p.isVisible !== false)
      .slice(0, 10) // Limiter pour ne pas dépasser le contexte
      .map(p => `- ${p.name} : ${(p.price || 0).toLocaleString('fr-FR')} FCFA${p.description ? ` (${p.description})` : ''}`)
      .join('\n');
    if (listeProduits) {
      sectionProduits = `\n\nProduits disponibles :\n${listeProduits}`;
    }
  }

  // Section localisation
  let sectionLocalisation = '';
  if (localisation) {
    sectionLocalisation = `\n\nLocalisation de la boutique : ${localisation}`;
  }

  // Section description
  let sectionDescription = '';
  if (description) {
    sectionDescription = `\nActivité : ${description}`;
  }

  return `Tu es l'assistante vocale IA de la boutique "${boutique}"${prenom ? `, dirigée par ${prenom}` : ''}, sur la plateforme KAZAP.${sectionDescription}${sectionLocalisation}${sectionProduits}${sectionFAQ}

TON RÔLE :
Tu réponds aux clients par téléphone, en français, avec une voix chaleureuse et professionnelle adaptée au marché ouest-africain.
Tes réponses sont courtes (2-3 phrases maximum) car elles seront lues à voix haute par un système TTS.

TES CAPACITÉS :
1. Prendre des commandes de produits disponibles dans la boutique
2. Fixer des rendez-vous (préciser date, heure, motif)
3. Répondre aux questions sur la boutique, les produits, les horaires, la livraison

DÉTECTION D'INTENTION :
À la fin de chaque réponse, tu DOIS toujours inclure un bloc JSON (sur une nouvelle ligne) avec cette structure exacte :
{"intention":"commande","details":{"clientNom":null,"clientTelephone":null,"produit":null,"quantite":1,"resume":"résumé de la commande"}}
{"intention":"rdv","details":{"clientNom":null,"clientTelephone":null,"date":null,"heure":null,"motif":null,"resume":"résumé du RDV"}}
{"intention":"info","details":{"question":"question posée","resume":"réponse donnée"}}
{"intention":"inconnu","details":{"resume":"description de la demande"}}

Remplis les champs "details" avec les informations que le client a mentionnées dans la conversation.
Si une information n'a pas été mentionnée, laisse null.

RÈGLES IMPORTANTES :
- Parle UNIQUEMENT en français
- Sois concise : maximum 2-3 phrases par réponse
- Adopte un ton chaleureux et professionnel
- Si le client veut commander, demande poliment son nom et son numéro de téléphone
- Ne donne JAMAIS de prix qui ne sont pas dans la liste des produits
- Si tu ne sais pas répondre, dis que tu transmets le message à l'équipe
- Ne mentionne JAMAIS que tu es une IA, présente-toi comme "l'assistante de ${boutique}"`;
}

/**
 * genererReponseIA
 * Appelle l'API Claude avec le contexte de la boutique et la transcription du client.
 *
 * @param {Object} options
 * @param {string}  options.transcription — Texte transcrit de la voix du client
 * @param {Object}  options.vendeurData   — Données Firestore du vendeur
 * @param {Array}   options.historique    — Historique de la conversation (optionnel)
 * @returns {Promise<{reponse: string, type: string, details: Object}>}
 */
async function genererReponseIA({ transcription, vendeurData, historique = [] }) {
  const cleApi = process.env.ANTHROPIC_API_KEY;
  if (!cleApi) {
    throw new Error('Variable d\'environnement ANTHROPIC_API_KEY manquante');
  }

  if (!transcription || !transcription.trim()) {
    return {
      reponse: 'Je n\'ai pas bien entendu votre message. Pouvez-vous répéter, s\'il vous plaît ?',
      type:    'inconnu',
      details: { resume: 'Transcription vide ou inaudible' }
    };
  }

  const client = new Anthropic.default({ apiKey: cleApi });

  // Construire le prompt système à partir des données du vendeur
  const promptSysteme = construirePromptSysteme(vendeurData);

  // Construire l'historique de conversation pour le contexte
  const messagesHistorique = historique.map(msg => ({
    role:    msg.role === 'ia' ? 'assistant' : 'user',
    content: msg.texte
  }));

  // Ajouter le message du client
  const messages = [
    ...messagesHistorique,
    {
      role:    'user',
      content: transcription.trim()
    }
  ];

  let texteComplet = '';

  // Appel à Claude avec timeout
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timeout Claude API (15s)')), CLAUDE_TIMEOUT_MS)
  );

  const claudePromise = client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: MAX_TOKENS,
    system:     promptSysteme,
    messages
  });

  const reponseAPI = await Promise.race([claudePromise, timeoutPromise]);

  // Extraire le texte de la réponse
  texteComplet = reponseAPI.content
    .filter(bloc => bloc.type === 'text')
    .map(bloc => bloc.text)
    .join('');

  if (!texteComplet) {
    throw new Error('Réponse Claude vide');
  }

  // Séparer le texte vocal du bloc JSON d'intention
  const { texteVocal, intention, details } = _extraireIntention(texteComplet);

  console.log(`🤖 Claude → type: ${intention} | réponse: "${texteVocal.substring(0, 80)}..."`);

  return {
    reponse: texteVocal,
    type:    intention,
    details
  };
}

/**
 * _extraireIntention
 * Extrait le bloc JSON d'intention depuis la réponse Claude.
 * Le texte vocal est la partie avant le JSON.
 *
 * @param {string} texteComplet — Réponse brute de Claude
 * @returns {{ texteVocal: string, intention: string, details: Object }}
 */
function _extraireIntention(texteComplet) {
  // Chercher un bloc JSON {"intention":...} dans la réponse
  const regexJson = /\{[\s\S]*?"intention"\s*:\s*"(commande|rdv|info|inconnu)"[\s\S]*?\}/;
  const match = texteComplet.match(regexJson);

  if (!match) {
    // Pas de JSON trouvé → réponse informative par défaut
    return {
      texteVocal: texteComplet.trim(),
      intention:  'info',
      details:    { resume: texteComplet.trim().substring(0, 200) }
    };
  }

  // Texte vocal = tout ce qui est avant le JSON
  const indexJson = texteComplet.indexOf(match[0]);
  const texteVocal = texteComplet.substring(0, indexJson).trim();

  // Parser le JSON d'intention
  let parsed = {};
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    console.warn('⚠️ Impossible de parser le JSON d\'intention :', err.message);
  }

  return {
    texteVocal: texteVocal || texteComplet.trim(),
    intention:  parsed.intention || 'info',
    details:    parsed.details   || {}
  };
}

module.exports = {
  genererReponseIA,
  construirePromptSysteme
};
