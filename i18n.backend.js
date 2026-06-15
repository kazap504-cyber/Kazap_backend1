/* ============================================================
   KAZAP — i18n.backend.js
   Module de traduction FR / EN pour Node.js (backend)
   Version serveur de i18n.js — sans localStorage, window ni DOM.

   M-10a.1 : Traductions UI (30 clés)
   M-10b.1 : Textes IA conversationnelle (8 clés)
   M-10b.2 : Config voix Twilio (TTS) & Deepgram (STT)

   Usage :
     const { t, tpl, getVoiceConfig } = require('./i18n.backend');
     t('ia.welcomeMsg', 'fr')
     tpl('ia.welcomeMsg', { boutique: 'Fatou Mode' }, 'fr')
     getVoiceConfig('en')  // → { twilioVoice, twilioLang, deepgramLang }
   ============================================================ */

'use strict';

// ─── Dictionnaire de traductions ─────────────────────────────────────────────

const KAZAP_I18N = {
  fr: {
    /* ── Navigation ── */
    'nav.accueil':    'Accueil',
    'nav.boutique':   'Boutique',
    'nav.outils':     'Outils',
    'nav.parametres': 'Paramètres',

    /* ── Dashboard ── */
    'dashboard.title':                  'Tableau de bord',
    'dashboard.callsHandledByIA':       'Appels pris par IA',
    'dashboard.rdvFixedToday':          'RDV fixés aujourd\'hui',
    'dashboard.viewAll':                'Voir tout →',
    'dashboard.rdvToday':               'RDV du jour',
    'dashboard.callsReceivedRealtime':  'Appels reçus (temps réel)',
    'dashboard.rdvTotal':               'RDV total',
    'dashboard.activeProducts':         'Produits actifs',
    'dashboard.topProducts':            'Top produits',

    /* ── Boutique ── */
    'shop.myShop':          'Ma Boutique',
    'shop.yourShop':        'Votre boutique',
    'shop.category':        'Catégorie',
    'shop.copy':            'Copier',
    'shop.view':            'Voir',
    'shop.myProducts':      'Mes produits',
    'shop.newProduct':      '+ Nouveau produit',
    'shop.addFirstProduct': 'Ajoutez votre premier produit !',
    'shop.all':             'Toutes',
    'shop.delivered':       'Livrées',
    'shop.newRdv':          '+ Nouveau RDV',

    /* ── Table ── */
    'table.date':    'Date',
    'table.id':      'ID',
    'table.product': 'Produit',
    'table.status':  'Statut',
    'table.total':   'Total',

    /* ── Commandes IA ── */
    'order.takenByIA': 'Commande prise par l\'IA lors d\'un appel',
    'order.confirm':   'Confirmer la commande et notifier le client par SMS',
    'order.reject':    'Rejeter la commande et notifier le client par SMS',

    /* ── Paramètres ── */
    'settings.title':    'Paramètres',
    'settings.subtitle': 'Gérez votre compte et votre boutique',

    /* ────────────────────────────────────────────────────────
       M-10b.1 — Textes IA conversationnelle
       ──────────────────────────────────────────────────────── */

    'ia.welcomeMsg':         'Bonjour, je suis l\'assistante de {boutique}. Comment puis-je vous aider ?',
    'ia.welcomeMsgFallback': 'Bonjour ! Comment puis-je vous aider ?',
    'ia.welcomeDtmf':        'Bonjour et bienvenue chez {boutique}. Notre assistant virtuel vous répond.',

    'ia.systemPrompt.role': 'Tu es l\'assistante vocale IA de la boutique "{boutique}"{prenom}, sur la plateforme KAZAP.{description}{localisation}{produits}{agenda}{faq}\n\nTON RÔLE :\nTu réponds aux clients par téléphone, en français, avec une voix chaleureuse et professionnelle adaptée au marché ouest-africain.\nTes réponses sont courtes (2-3 phrases maximum) car elles seront lues à voix haute par un système TTS.\n\nTES CAPACITÉS :\n1. Prendre des commandes de produits disponibles dans la boutique\n2. Fixer des rendez-vous (préciser date, heure, motif)\n3. Répondre aux questions sur la boutique, les produits, les horaires, la livraison\n\n═══ LOGIQUE DE PRISE DE COMMANDE (PRIORITÉ HAUTE) ═══\n\nQuand un client veut commander, tu dois collecter ces informations dans l\'ordre, une à la fois :\n  1. Le produit exact (si pas encore précisé)\n  2. La quantité (si pas encore précisée)\n  3. L\'adresse de livraison (si pas encore précisée)\n  4. Le nom du client (si pas encore précisé)\n\nTu poses UNE SEULE question à la fois. Tu n\'en poses pas deux en même temps.\n\nQuand tu as collecté le produit, la quantité ET l\'adresse, tu DOIS :\n  a) Lire le récapitulatif complet à voix haute : produit, quantité, adresse, total FCFA\n  b) Demander : "Confirmez-vous cette commande ?"\n  c) Attendre la réponse du client\n\nSi le client dit OUI / confirme / d\'accord / c\'est bon → dans le JSON, mets "statut_commande":"confirmee"\nSi le client dit NON / annule / pas d\'accord → dans le JSON, mets "statut_commande":"annulee"\nTant que le client n\'a pas confirmé → mets "statut_commande":"en_cours"\n\n═══ DÉTECTION D\'INTENTION ═══\n\nÀ la fin de chaque réponse, tu DOIS toujours inclure un bloc JSON (sur une nouvelle ligne) :\n\nPour une commande :\n{"intention":"commande","details":{"clientNom":null,"clientTelephone":null,"produit":null,"quantite":1,"adresse":null,"total":0,"statut_commande":"en_cours","resume":"résumé de la commande"}}\n\nPour un RDV :\n{"intention":"rdv","details":{"clientNom":null,"clientTelephone":null,"date":null,"heure":null,"motif":null,"resume":"résumé du RDV"}}\n\nPour une info :\n{"intention":"info","details":{"question":"question posée","resume":"réponse donnée"}}\n\nPour inconnu :\n{"intention":"inconnu","details":{"resume":"description de la demande"}}\n\nRemplis les champs "details" avec TOUTES les informations collectées au fil de la conversation.\nSi une info n\'est pas encore connue, laisse null.\nPour "total" : calcule le prix × quantité selon le catalogue. Si prix inconnu, laisse 0.\n\nRÈGLES IMPORTANTES :\n- Parle UNIQUEMENT en français\n- Sois concise : maximum 2-3 phrases par réponse vocale\n- Adopte un ton chaleureux et professionnel\n- Ne donne JAMAIS de prix absents du catalogue\n- Si tu ne sais pas répondre, dis que tu transmets le message à l\'équipe\n- Ne mentionne JAMAIS que tu es une IA, présente-toi comme "l\'assistante de {boutique}"',

    'ia.systemPrompt.agendaAvailable':   '== AGENDA — CRÉNEAUX LIBRES ==\nVoici les prochains créneaux disponibles pour un rendez-vous : {creneaux}\nQuand le client demande un RDV, propose ces créneaux. S\'il en choisit un, confirme-le clairement et retourne intention "rdv".',
    'ia.systemPrompt.agendaUnavailable': '== AGENDA ==\nL\'agenda n\'est pas disponible en ce moment. Si le client demande un RDV, dis-lui que tu vas transmettre sa demande à l\'équipe et collecte son nom et son numéro.',

    'ia.speakDemo.feminin':  'Bonjour, je suis votre assistante Kazap, comment puis-je vous aider ?',
    'ia.speakDemo.masculin': 'Bonjour, je suis votre assistant Kazap, comment puis-je vous aider ?'
  },

  en: {
    /* ── Navigation ── */
    'nav.accueil':    'Home',
    'nav.boutique':   'Shop',
    'nav.outils':     'Tools',
    'nav.parametres': 'Settings',

    /* ── Dashboard ── */
    'dashboard.title':                  'Dashboard',
    'dashboard.callsHandledByIA':       'Calls handled by AI',
    'dashboard.rdvFixedToday':          'Appointments booked today',
    'dashboard.viewAll':                'View all →',
    'dashboard.rdvToday':               'Today\'s appointments',
    'dashboard.callsReceivedRealtime':  'Calls received (real-time)',
    'dashboard.rdvTotal':               'Total appointments',
    'dashboard.activeProducts':         'Active products',
    'dashboard.topProducts':            'Top products',

    /* ── Boutique ── */
    'shop.myShop':          'My Shop',
    'shop.yourShop':        'Your shop',
    'shop.category':        'Category',
    'shop.copy':            'Copy',
    'shop.view':            'View',
    'shop.myProducts':      'My products',
    'shop.newProduct':      '+ New product',
    'shop.addFirstProduct': 'Add your first product!',
    'shop.all':             'All',
    'shop.delivered':       'Delivered',
    'shop.newRdv':          '+ New appointment',

    /* ── Table ── */
    'table.date':    'Date',
    'table.id':      'ID',
    'table.product': 'Product',
    'table.status':  'Status',
    'table.total':   'Total',

    /* ── Commandes IA ── */
    'order.takenByIA': 'Order taken by AI during a call',
    'order.confirm':   'Confirm the order and notify the customer by SMS',
    'order.reject':    'Reject the order and notify the customer by SMS',

    /* ── Paramètres ── */
    'settings.title':    'Settings',
    'settings.subtitle': 'Manage your account and your shop',

    /* ────────────────────────────────────────────────────────
       M-10b.1 — IA conversational texts
       ──────────────────────────────────────────────────────── */

    'ia.welcomeMsg':         'Hello, I am the assistant for {boutique}. How can I help you?',
    'ia.welcomeMsgFallback': 'Hello! How can I help you?',
    'ia.welcomeDtmf':        'Hello and welcome to {boutique}. Our virtual assistant is here to help.',

    'ia.systemPrompt.role': 'You are the AI voice assistant for the shop "{boutique}"{prenom}, on the KAZAP platform.{description}{localisation}{produits}{agenda}{faq}\n\nYOUR ROLE:\nYou respond to customers by phone, in English, with a warm and professional voice adapted to the West African market.\nYour answers are short (2-3 sentences maximum) as they will be read aloud by a TTS system.\n\nYOUR CAPABILITIES:\n1. Take orders for products available in the shop\n2. Book appointments (specify date, time, reason)\n3. Answer questions about the shop, products, opening hours, and delivery\n\n═══ ORDER-TAKING LOGIC (HIGH PRIORITY) ═══\n\nWhen a customer wants to order, collect the following information in order, one at a time:\n  1. The exact product (if not yet specified)\n  2. The quantity (if not yet specified)\n  3. The delivery address (if not yet specified)\n  4. The customer\'s name (if not yet specified)\n\nAsk ONE question at a time. Never ask two at once.\n\nOnce you have collected the product, quantity AND address, you MUST:\n  a) Read the full summary aloud: product, quantity, address, total in FCFA\n  b) Ask: "Do you confirm this order?"\n  c) Wait for the customer\'s response\n\nIf the customer says YES / confirms / agrees / OK → set "statut_commande":"confirmee" in the JSON\nIf the customer says NO / cancels / disagrees → set "statut_commande":"annulee" in the JSON\nUntil the customer confirms → set "statut_commande":"en_cours"\n\n═══ INTENT DETECTION ═══\n\nAt the end of each response, you MUST always include a JSON block (on a new line):\n\nFor an order:\n{"intention":"commande","details":{"clientNom":null,"clientTelephone":null,"produit":null,"quantite":1,"adresse":null,"total":0,"statut_commande":"en_cours","resume":"order summary"}}\n\nFor an appointment:\n{"intention":"rdv","details":{"clientNom":null,"clientTelephone":null,"date":null,"heure":null,"motif":null,"resume":"appointment summary"}}\n\nFor information:\n{"intention":"info","details":{"question":"question asked","resume":"answer given"}}\n\nFor unknown:\n{"intention":"inconnu","details":{"resume":"description of the request"}}\n\nFill in the "details" fields with ALL information collected throughout the conversation.\nIf a piece of information is not yet known, leave it as null.\nFor "total": calculate price × quantity from the catalogue. If price is unknown, leave 0.\n\nIMPORTANT RULES:\n- Speak ONLY in English\n- Be concise: maximum 2-3 sentences per voice response\n- Use a warm and professional tone\n- NEVER give prices not listed in the catalogue\n- If you don\'t know the answer, say you will pass the message to the team\n- NEVER mention that you are an AI; introduce yourself as "the assistant of {boutique}"',

    'ia.systemPrompt.agendaAvailable':   '== AGENDA — AVAILABLE SLOTS ==\nHere are the next available time slots for an appointment: {creneaux}\nWhen the customer asks for an appointment, suggest these slots. If they choose one, confirm it clearly and return intent "rdv".',
    'ia.systemPrompt.agendaUnavailable': '== AGENDA ==\nThe agenda is not available right now. If the customer asks for an appointment, tell them you will pass their request to the team and collect their name and phone number.',

    'ia.speakDemo.feminin':  'Hello, I am your Kazap assistant, how can I help you?',
    'ia.speakDemo.masculin': 'Hello, I am your Kazap assistant, how can I help you?'
  }
};

// ─── M-10b.2 — Config voix Twilio (TTS) & Deepgram (STT) ────────────────────

const KAZAP_VOICE_CONFIG = {
  fr:  { twilioVoice: 'Polly.Lea',    twilioLang: 'fr-FR', deepgramLang: 'fr' },
  en:  { twilioVoice: 'Polly.Joanna', twilioLang: 'en-US', deepgramLang: 'en' },
  fon: { twilioVoice: 'Polly.Lea',    twilioLang: 'fr-FR', deepgramLang: 'fr' }, // fallback fr
  yo:  { twilioVoice: 'Polly.Joanna', twilioLang: 'en-US', deepgramLang: 'en' }  // fallback en
};

/**
 * Retourne la configuration voix/STT pour la langue donnée.
 * Fallback vers 'fr' si la langue est inconnue ou non supportée.
 * @param {string} lang - 'fr' | 'en' | 'fon' | 'yo'
 * @returns {{ twilioVoice: string, twilioLang: string, deepgramLang: string }}
 */
function getVoiceConfig(lang) {
  return KAZAP_VOICE_CONFIG[lang] || KAZAP_VOICE_CONFIG['fr'];
}

// ─── Helpers de traduction ────────────────────────────────────────────────────

/**
 * Retourne la traduction d'une clé pour la langue donnée.
 * Fallback : 'fr' si la clé est absente dans la langue active,
 * puis la clé elle-même si introuvable partout.
 * @param {string} key
 * @param {string} [lang='fr']
 * @returns {string}
 */
function t(key, lang = 'fr') {
  return (KAZAP_I18N[lang] && KAZAP_I18N[lang][key])
      || (KAZAP_I18N.fr    && KAZAP_I18N.fr[key])
      || key;
}

/**
 * Interpolation : remplace {variable} dans une chaîne traduite.
 * @param {string} key
 * @param {Object} [vars]
 * @param {string} [lang='fr']
 * @returns {string}
 *
 * @example
 * tpl('ia.welcomeMsg', { boutique: 'Fatou Mode' }, 'en')
 * // → "Hello, I am the assistant for Fatou Mode. How can I help you?"
 */
function tpl(key, vars, lang = 'fr') {
  let str = t(key, lang);
  if (vars) {
    Object.entries(vars).forEach(([k, v]) => {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), v != null ? v : '');
    });
  }
  return str;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  KAZAP_I18N,
  KAZAP_VOICE_CONFIG,
  getVoiceConfig,
  t,
  tpl
};

/* ============================================================
   USAGE DANS server.js (ou tout autre module Node.js) :

   const { t, tpl, getVoiceConfig } = require('./i18n.backend');

   // Voix Twilio + langue Deepgram selon le vendeur :
   const lang = vendeurData?.settings?.lang || 'fr';
   const vc   = getVoiceConfig(lang);
   twiml.say({ language: vc.twilioLang, voice: vc.twilioVoice }, msgAccueil);
   // deepgramLang → vc.deepgramLang  ('fr' ou 'en')

   // Traduction d'un texte IA :
   const msg = tpl('ia.welcomeMsg', { boutique: 'Fatou Mode' }, lang);

   CONTRAINTES :
   - Pas de localStorage, window, document ni DOMContentLoaded
   - Langue passée en paramètre (pas de state global)
   - Fon/yoruba en fallback (fr / en) — pas de TTS dédié (Phase 3)
   - Langue par défaut : 'fr'
   ============================================================ */
