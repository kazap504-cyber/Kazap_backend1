/**
 * KAZAP — claude-agent.js
 * Module IA : appel à l'API Claude Anthropic.
 *
 * Rôle :
 *   - Construire le prompt système KAZAP à partir des données du vendeur
 *   - Détecter l'intention du client (commande / rdv / info / inconnu)
 *   - Générer une réponse en français ou en anglais selon la langue active
 *   - Retourner la réponse + le type d'intention + les détails structurés
 *
 * Modèle utilisé : claude-sonnet-4-6 (performant, rapide, économique)
 *
 * M-10b.1 : Le prompt système et le message d'accueil sont maintenant
 *            sélectionnés selon le paramètre `lang` ('fr' | 'en').
 *            Les chaînes sont issues de KAZAP_I18N (i18n.js côté serveur)
 *            via le module ./i18n-server.js (voir ci-dessous).
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');

// Délai maximum pour la réponse Claude (15 secondes)
const CLAUDE_TIMEOUT_MS = 15_000;

// Nombre maximum de tokens pour la réponse (garder court pour le TTS)
const MAX_TOKENS = 300;

/* ────────────────────────────────────────────────────────────────────
   M-10b.1 — Traductions côté serveur (miroir de i18n.js côté client)
   Définies ici directement pour éviter une dépendance circulaire.
   À synchroniser avec KAZAP_I18N dans i18n.js si de nouvelles clés
   ia.* sont ajoutées.
   ──────────────────────────────────────────────────────────────────── */
const IA_PROMPTS = {
  fr: {
    role:              'Tu es l\'assistante vocale IA',
    langue:            'français',
    confirmQuestion:   'Confirmez-vous cette commande ?',
    orderSummaryLabel: 'résumé de la commande',
    rdvSummaryLabel:   'résumé du RDV',
    questionLabel:     'question posée',
    answerLabel:       'réponse donnée',
    requestLabel:      'description de la demande',
    rules: [
      'Parle UNIQUEMENT en français',
      'Sois concise : maximum 2-3 phrases par réponse vocale',
      'Adopte un ton chaleureux et professionnel',
      'Ne donne JAMAIS de prix absents du catalogue',
      'Si tu ne sais pas répondre, dis que tu transmets le message à l\'équipe',
    ],
    selfIntro:         'l\'assistante de',
    roleDesc:          'Tu réponds aux clients par téléphone, en français, avec une voix chaleureuse et professionnelle adaptée au marché ouest-africain.',
    ttsNote:           'Tes réponses sont courtes (2-3 phrases maximum) car elles seront lues à voix haute par un système TTS.',
    capabilities:      '1. Prendre des commandes de produits disponibles dans la boutique\n2. Fixer des rendez-vous (préciser date, heure, motif)\n3. Répondre aux questions sur la boutique, les produits, les horaires, la livraison',
    orderLogicTitle:   '═══ LOGIQUE DE PRISE DE COMMANDE (PRIORITÉ HAUTE) ═══',
    orderSteps:        'Quand un client veut commander, tu dois collecter ces informations dans l\'ordre, une à la fois :\n  1. Le produit exact (si pas encore précisé)\n  2. La quantité (si pas encore précisée)\n  3. L\'adresse de livraison (si pas encore précisée)\n  4. Le nom du client (si pas encore précisé)\n\nTu poses UNE SEULE question à la fois. Tu n\'en poses pas deux en même temps.',
    orderConfirmSteps: 'Quand tu as collecté le produit, la quantité ET l\'adresse, tu DOIS :\n  a) Lire le récapitulatif complet à voix haute : produit, quantité, adresse, total FCFA\n  b) Demander : "Confirmez-vous cette commande ?"\n  c) Attendre la réponse du client',
    orderStatuses:     'Si le client dit OUI / confirme / d\'accord / c\'est bon → dans le JSON, mets "statut_commande":"confirmee"\nSi le client dit NON / annule / pas d\'accord → dans le JSON, mets "statut_commande":"annulee"\nTant que le client n\'a pas confirmé → mets "statut_commande":"en_cours"',
    intentTitle:       '═══ DÉTECTION D\'INTENTION ═══',
    intentDesc:        'À la fin de chaque réponse, tu DOIS toujours inclure un bloc JSON (sur une nouvelle ligne) :',
    agendaAvail:       (creneaux) => `== AGENDA — CRÉNEAUX LIBRES ==\nVoici les prochains créneaux disponibles pour un rendez-vous : ${creneaux}\nQuand le client demande un RDV, propose ces créneaux. S'il en choisit un, confirme-le clairement et retourne intention "rdv".`,
    agendaUnavail:     '== AGENDA ==\nL\'agenda n\'est pas disponible en ce moment. Si le client demande un RDV, dis-lui que tu vas transmettre sa demande à l\'équipe et collecte son nom et son numéro.',
    productsHeader:    'Produits disponibles',
    faqHeader:         'Questions fréquentes de cette boutique',
    localisationLabel: 'Localisation de la boutique',
    activityLabel:     'Activité',
  },
  en: {
    role:              'You are the AI voice assistant',
    langue:            'English',
    confirmQuestion:   'Do you confirm this order?',
    orderSummaryLabel: 'order summary',
    rdvSummaryLabel:   'appointment summary',
    questionLabel:     'question asked',
    answerLabel:       'answer given',
    requestLabel:      'description of the request',
    rules: [
      'Speak ONLY in English',
      'Be concise: maximum 2-3 sentences per voice response',
      'Use a warm and professional tone',
      'NEVER give prices not listed in the catalogue',
      'If you don\'t know the answer, say you will pass the message to the team',
    ],
    selfIntro:         'the assistant of',
    roleDesc:          'You respond to customers by phone, in English, with a warm and professional voice adapted to the West African market.',
    ttsNote:           'Your answers are short (2-3 sentences maximum) as they will be read aloud by a TTS system.',
    capabilities:      '1. Take orders for products available in the shop\n2. Book appointments (specify date, time, reason)\n3. Answer questions about the shop, products, opening hours, and delivery',
    orderLogicTitle:   '═══ ORDER-TAKING LOGIC (HIGH PRIORITY) ═══',
    orderSteps:        'When a customer wants to order, collect the following information in order, one at a time:\n  1. The exact product (if not yet specified)\n  2. The quantity (if not yet specified)\n  3. The delivery address (if not yet specified)\n  4. The customer\'s name (if not yet specified)\n\nAsk ONE question at a time. Never ask two at once.',
    orderConfirmSteps: 'Once you have collected the product, quantity AND address, you MUST:\n  a) Read the full summary aloud: product, quantity, address, total in FCFA\n  b) Ask: "Do you confirm this order?"\n  c) Wait for the customer\'s response',
    orderStatuses:     'If the customer says YES / confirms / agrees / OK → set "statut_commande":"confirmee" in the JSON\nIf the customer says NO / cancels / disagrees → set "statut_commande":"annulee" in the JSON\nUntil the customer confirms → set "statut_commande":"en_cours"',
    intentTitle:       '═══ INTENT DETECTION ═══',
    intentDesc:        'At the end of each response, you MUST always include a JSON block (on a new line):',
    agendaAvail:       (creneaux) => `== AGENDA — AVAILABLE SLOTS ==\nHere are the next available time slots for an appointment: ${creneaux}\nWhen the customer asks for an appointment, suggest these slots. If they choose one, confirm it clearly and return intent "rdv".`,
    agendaUnavail:     '== AGENDA ==\nThe agenda is not available right now. If the customer asks for an appointment, tell them you will pass their request to the team and collect their name and phone number.',
    productsHeader:    'Available products',
    faqHeader:         'Frequently asked questions for this shop',
    localisationLabel: 'Shop location',
    activityLabel:     'Business type',
  }
};

/**
 * Construire le prompt système KAZAP à partir des données du vendeur.
 * Ce prompt est le cœur de l'IA vocale.
 *
 * @param {Object} vendeurData     — Document Firestore du vendeur (collection vendors)
 * @param {string} creneauxAgenda  — Texte oral des créneaux libres (depuis agenda-reader.js)
 * @param {string} lang            — Langue active : 'fr' (défaut) | 'en'  [M-10b.1]
 * @returns {string} — Prompt système complet
 */
function construirePromptSysteme(vendeurData, creneauxAgenda = null, lang = 'fr') {
  const boutique   = vendeurData?.boutiqueName   || (lang === 'en' ? 'the shop' : 'la boutique');
  const prenom     = vendeurData?.prenom         || '';
  const produits   = vendeurData?.products       || [];
  const faq        = vendeurData?.settings?.iaFAQ || [];
  const localisation = vendeurData?.localisation || null;
  const description  = vendeurData?.description  || vendeurData?.category || null;

  /* Sélectionner les chaînes selon la langue (fallback : 'fr') */
  const L = IA_PROMPTS[lang] || IA_PROMPTS.fr;

  // Section FAQ dynamique
  let sectionFAQ = '';
  if (faq.length > 0) {
    const faqLabel = lang === 'en' ? 'Q' : 'Q';
    const repLabel = lang === 'en' ? 'A' : 'R';
    sectionFAQ = `\n\n${L.faqHeader} :\n` +
      faq.map(f => `${faqLabel}: ${f.q}\n${repLabel}: ${f.r}`).join('\n\n');
  }

  // Section produits (si disponibles)
  let sectionProduits = '';
  if (Array.isArray(produits) && produits.length > 0) {
    const listeProduits = produits
      .filter(p => p.isAvailable !== false && p.isVisible !== false)
      .slice(0, 10)
      .map(p => `- ${p.name} : ${(p.price || 0).toLocaleString('fr-FR')} FCFA${p.description ? ` (${p.description})` : ''}`)
      .join('\n');
    if (listeProduits) {
      sectionProduits = `\n\n${L.productsHeader} :\n${listeProduits}`;
    }
  }

  // Section localisation
  let sectionLocalisation = '';
  if (localisation) {
    sectionLocalisation = `\n\n${L.localisationLabel} : ${localisation}`;
  }

  // Section description
  let sectionDescription = '';
  if (description) {
    sectionDescription = `\n${L.activityLabel} : ${description}`;
  }

  // Section agenda (créneaux libres injectés en temps réel)
  let sectionAgenda = '';
  if (creneauxAgenda && creneauxAgenda !== 'agenda non disponible' && creneauxAgenda !== 'agenda temporairement indisponible') {
    sectionAgenda = `\n\n${L.agendaAvail(creneauxAgenda)}`;
  } else {
    sectionAgenda = `\n\n${L.agendaUnavail}`;
  }

  return `${L.role} de la boutique "${boutique}"${prenom ? `, dirigée par ${prenom}` : ''}, sur la plateforme KAZAP.${sectionDescription}${sectionLocalisation}${sectionProduits}${sectionAgenda}${sectionFAQ}

TON RÔLE :
${L.roleDesc}
${L.ttsNote}

TES CAPACITÉS :
${L.capabilities}

${L.orderLogicTitle}

${L.orderSteps}

${L.orderConfirmSteps}

${L.orderStatuses}

${L.intentTitle}

${L.intentDesc}

Pour une commande :
{"intention":"commande","details":{"clientNom":null,"clientTelephone":null,"produit":null,"quantite":1,"adresse":null,"total":0,"statut_commande":"en_cours","resume":"${L.orderSummaryLabel}"}}

Pour un RDV :
{"intention":"rdv","details":{"clientNom":null,"clientTelephone":null,"date":null,"heure":null,"motif":null,"resume":"${L.rdvSummaryLabel}"}}

Pour une info :
{"intention":"info","details":{"question":"${L.questionLabel}","resume":"${L.answerLabel}"}}

Pour inconnu :
{"intention":"inconnu","details":{"resume":"${L.requestLabel}"}}

Remplis les champs "details" avec TOUTES les informations collectées au fil de la conversation.
Si une info n'est pas encore connue, laisse null.
Pour "total" : calcule le prix × quantité selon le catalogue. Si prix inconnu, laisse 0.

RÈGLES IMPORTANTES :
${L.rules.map(r => `- ${r}`).join('\n')}
- Ne mentionne JAMAIS que tu es une IA, présente-toi comme "${L.selfIntro} ${boutique}"`;
}

/**
 * genererReponseIA
 * Appelle l'API Claude avec le contexte de la boutique et la transcription du client.
 *
 * @param {Object} options
 * @param {string}  options.transcription   — Texte transcrit de la voix du client
 * @param {Object}  options.vendeurData     — Données Firestore du vendeur
 * @param {Array}   options.historique      — Historique de la conversation (optionnel)
 * @param {string}  options.creneauxAgenda  — Créneaux libres depuis agenda-reader.js (optionnel)
 * @param {string}  options.lang            — Langue active : 'fr' (défaut) | 'en'  [M-10b.1]
 * @returns {Promise<{reponse: string, type: string, details: Object}>}
 */
async function genererReponseIA({ transcription, vendeurData, historique = [], creneauxAgenda = null, lang = 'fr' }) {
  const cleApi = process.env.ANTHROPIC_API_KEY;
  if (!cleApi) {
    throw new Error('Variable d\'environnement ANTHROPIC_API_KEY manquante');
  }

  if (!transcription || !transcription.trim()) {
    const msgVide = lang === 'en'
      ? 'I didn\'t catch your message. Could you please repeat?'
      : 'Je n\'ai pas bien entendu votre message. Pouvez-vous répéter, s\'il vous plaît ?';
    return {
      reponse: msgVide,
      type:    'inconnu',
      details: { resume: lang === 'en' ? 'Empty or inaudible transcription' : 'Transcription vide ou inaudible' }
    };
  }

  const client = new Anthropic.default({ apiKey: cleApi });

  /* M-10b.1 — Prompt système selon la langue active */
  const promptSysteme = construirePromptSysteme(vendeurData, creneauxAgenda, lang);

  // Construire l'historique de conversation pour le contexte
  const messagesHistorique = historique.map(msg => ({
    role:    msg.role === 'ia' ? 'assistant' : 'user',
    content: msg.texte
  }));

  const messages = [
    ...messagesHistorique,
    {
      role:    'user',
      content: transcription.trim()
    }
  ];

  let texteComplet = '';

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

  texteComplet = reponseAPI.content
    .filter(bloc => bloc.type === 'text')
    .map(bloc => bloc.text)
    .join('');

  if (!texteComplet) {
    throw new Error('Réponse Claude vide');
  }

  const { texteVocal, intention, details, statutCommande } = _extraireIntention(texteComplet);

  console.log(`🤖 Claude [${lang}] → type: ${intention} | statut_commande: ${statutCommande || 'n/a'} | réponse: "${texteVocal.substring(0, 80)}..."`);

  return {
    reponse:        texteVocal,
    type:           intention,
    details,
    statutCommande
  };
}

/**
 * _extraireIntention
 * Extrait le bloc JSON d'intention depuis la réponse Claude.
 */
function _extraireIntention(texteComplet) {
  const regexJson = /\{[\s\S]*?"intention"\s*:\s*"(commande|rdv|info|inconnu)"[\s\S]*?\}/;
  const match = texteComplet.match(regexJson);

  if (!match) {
    return {
      texteVocal:      texteComplet.trim(),
      intention:       'info',
      details:         { resume: texteComplet.trim().substring(0, 200) },
      statutCommande:  null
    };
  }

  const indexJson  = texteComplet.indexOf(match[0]);
  const texteVocal = texteComplet.substring(0, indexJson).trim();

  let parsed = {};
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    console.warn('⚠️ Impossible de parser le JSON d\'intention :', err.message);
  }

  const details        = parsed.details || {};
  const statutCommande = details.statut_commande || null;

  return {
    texteVocal:     texteVocal || texteComplet.trim(),
    intention:      parsed.intention || 'info',
    details,
    statutCommande
  };
}

/**
 * commandeEstComplete
 * Vérifie si tous les champs requis pour une commande sont renseignés.
 */
function commandeEstComplete(details) {
  return !!(details?.produit && details?.quantite && details?.adresse);
}

/**
 * getIAWelcomeMsg
 * Retourne le message d'accueil IA par défaut selon la langue.
 * Utilisé par server.js pour le fallback si iaWelcomeMsg n'est pas défini.
 *
 * @param {string} boutiqueName — Nom de la boutique
 * @param {string} lang         — Langue active : 'fr' | 'en'  [M-10b.1]
 * @returns {string}
 */
function getIAWelcomeMsg(boutiqueName, lang = 'fr') {
  const nom = boutiqueName || (lang === 'en' ? 'our shop' : 'la boutique');
  if (lang === 'en') {
    return `Hello, I am the assistant for ${nom}. How can I help you?`;
  }
  return `Bonjour, je suis l'assistante de ${nom}. Comment puis-je vous aider ?`;
}

/**
 * getIAWelcomeDtmf
 * Message d'accueil DTMF (vendor indisponible) selon la langue.
 *
 * @param {string} boutiqueName
 * @param {string} lang
 * @returns {string}
 */
function getIAWelcomeDtmf(boutiqueName, lang = 'fr') {
  const nom = boutiqueName || (lang === 'en' ? 'our shop' : 'notre boutique');
  if (lang === 'en') {
    return `Hello and welcome to ${nom}. Our virtual assistant is here to help.`;
  }
  return `Bonjour et bienvenue chez ${nom}. Notre assistant virtuel vous répond.`;
}

/* ────────────────────────────────────────────────────────────────────
   Partie 2b/3 — Messagerie écrite acheteur/vendeur
   Interception optionnelle par l'assistant IA M-01 sur le canal écrit.
   Réutilisation STRICTEMENT EN LECTURE de construirePromptSysteme() et
   de IA_PROMPTS (M-01 vocal) définis plus haut : aucune modification ni
   restructuration de ceux-ci. On adapte uniquement, via une section
   ajoutée en fin de prompt, les consignes propres à la voix/au TTS
   (longueur 2-3 phrases, lecture à voix haute) qui ne s'appliquent pas
   à un message écrit, et on injecte éventuellement le ton formel/
   informel du vendeur s'il est configuré.
   ──────────────────────────────────────────────────────────────────── */

// Tokens max pour une réponse écrite (peut être plus longue qu'à l'oral)
const MAX_TOKENS_ECRIT = 500;

// Instructions de ton, appliquées seulement si vendors/{id}.settings.iaTone
// vaut explicitement 'formel' ou 'informel' (champ additif, optionnel)
const TON_INSTRUCTIONS = {
  fr: {
    formel:   'Adopte un ton formel : vouvoie systématiquement le client.',
    informel: 'Adopte un ton informel et chaleureux, tutoie le client si le contexte s\'y prête.'
  },
  en: {
    formel:   'Use a formal tone and address the customer respectfully.',
    informel: 'Use an informal, warm and friendly tone with the customer.'
  }
};

/**
 * construirePromptSystemeEcrit
 * Adapte le prompt système M-01 (vocal) au canal écrit de la messagerie.
 * Réutilise construirePromptSysteme() en lecture seule (aucune modification
 * de la fonction ni de IA_PROMPTS) et complète simplement le prompt avec
 * une section d'adaptation au canal + le ton du vendeur si configuré.
 *
 * @param {Object} vendeurData
 * @param {string} lang       — 'fr' (défaut) | 'en'
 * @param {string} tonalite   — 'formel' | 'informel' | null  (vendors/{id}.settings.iaTone)
 * @returns {string}
 */
function construirePromptSystemeEcrit(vendeurData, lang = 'fr', tonalite = null) {
  // Pas de créneaux d'agenda dans le contexte de la messagerie écrite
  const promptVocalBase = construirePromptSysteme(vendeurData, null, lang);

  const adaptationEcrit = lang === 'en'
    ? '\n\n== WRITTEN CHANNEL ADAPTATION ==\n'
      + 'You are now replying by WRITTEN CHAT MESSAGE, not by phone.\n'
      + 'Ignore any earlier instruction limiting you to 2-3 spoken sentences or referring to TTS/voice reading: write a clear, well-formed chat message instead.\n'
      + 'Do not reference appointment time slots ("agenda"), none were provided for this written exchange.'
    : '\n\n== ADAPTATION AU CANAL ÉCRIT ==\n'
      + 'Tu réponds maintenant par MESSAGE ÉCRIT dans la messagerie, pas par téléphone.\n'
      + 'Ignore toute consigne précédente limitant tes réponses à 2-3 phrases orales ou relative à une lecture TTS : rédige à la place un message écrit clair et bien formé.\n'
      + 'Ne fais pas référence à des créneaux d\'agenda, aucun n\'a été fourni pour cet échange écrit.';

  const instructionTon = (tonalite === 'formel' || tonalite === 'informel')
    ? `\n\n${(TON_INSTRUCTIONS[lang] || TON_INSTRUCTIONS.fr)[tonalite]}`
    : '';

  return `${promptVocalBase}${adaptationEcrit}${instructionTon}`;
}

/**
 * genererReponseIAEcrit
 * Variante "canal écrit" de genererReponseIA, pour l'interception
 * optionnelle des messages de la messagerie acheteur/vendeur (Partie 2b/3).
 * Réutilise le même mécanisme (client Anthropic, timeout, extraction
 * d'intention) que M-01 vocal, en lecture seule.
 *
 * @param {Object} options
 * @param {string} options.message      — Texte du nouveau message client
 * @param {Object} options.vendeurData  — Document Firestore du vendeur
 * @param {Array}  options.historique   — Historique [{role, texte}] (optionnel)
 * @param {string} options.lang         — 'fr' (défaut) | 'en'
 * @param {string} options.tonalite     — 'formel' | 'informel' | null
 * @returns {Promise<{reponse: string, type: string, details: Object, statutCommande: (string|null)}>}
 */
async function genererReponseIAEcrit({ message, vendeurData, historique = [], lang = 'fr', tonalite = null }) {
  const cleApi = process.env.ANTHROPIC_API_KEY;
  if (!cleApi) {
    throw new Error('Variable d\'environnement ANTHROPIC_API_KEY manquante');
  }

  if (!message || !message.trim()) {
    throw new Error('Message client vide');
  }

  const client = new Anthropic.default({ apiKey: cleApi });

  const promptSysteme = construirePromptSystemeEcrit(vendeurData, lang, tonalite);

  const messagesHistorique = historique.map(msg => ({
    role:    msg.role === 'ia' ? 'assistant' : 'user',
    content: msg.texte
  }));

  const messages = [
    ...messagesHistorique,
    { role: 'user', content: message.trim() }
  ];

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timeout Claude API (15s)')), CLAUDE_TIMEOUT_MS)
  );

  const claudePromise = client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: MAX_TOKENS_ECRIT,
    system:     promptSysteme,
    messages
  });

  const reponseAPI = await Promise.race([claudePromise, timeoutPromise]);

  const texteComplet = reponseAPI.content
    .filter(bloc => bloc.type === 'text')
    .map(bloc => bloc.text)
    .join('');

  if (!texteComplet) {
    throw new Error('Réponse Claude vide');
  }

  const { texteVocal, intention, details, statutCommande } = _extraireIntention(texteComplet);

  console.log(`🤖 Claude [messagerie/${lang}] → type: ${intention} | réponse: "${texteVocal.substring(0, 80)}..."`);

  return {
    reponse: texteVocal,
    type:    intention,
    details,
    statutCommande
  };
}

module.exports = {
  genererReponseIA,
  construirePromptSysteme,
  commandeEstComplete,
  getIAWelcomeMsg,          // M-10b.1
  getIAWelcomeDtmf,         // M-10b.1
  genererReponseIAEcrit,        // Partie 2b/3 — messagerie écrite
  construirePromptSystemeEcrit  // Partie 2b/3 — messagerie écrite
};
