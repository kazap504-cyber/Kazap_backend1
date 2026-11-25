/**
 * KAZAP — boutique-context.js
 * Ancrage de l'assistante IA sur les donnees reelles de la boutique.
 *
 * Probleme corrige : les produits d'une boutique sont stockes dans la collection
 * Firestore "products" (champ vendorId), alors que le prompt de l'assistante lisait
 * vendeurData.products, un champ qui n'existe pas dans le document vendeur. Le
 * catalogue n'etait donc jamais transmis au modele, qui repondait de memoire.
 *
 * Ce module :
 *   - lit le catalogue reel (collection products, requete sur un seul champ : aucun
 *     index composite necessaire) avec un cache court ;
 *   - le place dans une copie du document vendeur (champs products, _catalogueLu,
 *     _catalogueTronque), sans jamais modifier le document d'origine ;
 *   - fournit une verification deterministe d'une commande avant son enregistrement
 *     (produit present dans le catalogue, prix, total, stock).
 *
 * Aucune ecriture Firestore. Aucune dependance interne (seulement firebase-admin,
 * deja initialise par server.js).
 */

'use strict';

const admin  = require('firebase-admin');
const crypto = require('crypto');

const CFG = {
  ttlMs:        Number(process.env.CATALOGUE_CACHE_MS) || 30_000, // un prix modifie est pris en compte en 30 s au plus
  maxProduits:  60,    // produits injectes dans le prompt (limite Pro : 50 ; Premium : illimite)
  maxLecture:   200    // documents lus au maximum (les produits masques ou epuises sont filtres ensuite)
};

const _cache = new Map(); // vendeurId -> { ms, resultat }

function _db() { return admin.firestore(); }

/** Minuscules, sans accents ni ponctuation : sert aux rapprochements de noms de produits. */
function normaliser(texte) {
  return String(texte || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Lit les produits visibles et disponibles d'un vendeur.
 * @returns {Promise<{lu:boolean, produits:Array, tronque:boolean}>}
 *   lu = false si la lecture a echoue : l'appelant ne doit alors rien affirmer sur le catalogue.
 */
async function chargerCatalogue(vendeurId, options = {}) {
  if (!vendeurId || typeof vendeurId !== 'string') return { lu: false, produits: [], tronque: false };
  const maintenant = Date.now();
  const enCache = _cache.get(vendeurId);
  if (enCache && maintenant - enCache.ms < CFG.ttlMs) return enCache.resultat;

  try {
    const db = options.db || _db();
    const snap = await db.collection('products')
      .where('vendorId', '==', vendeurId)
      .limit(CFG.maxLecture)
      .get();

    const tous = [];
    snap.forEach(doc => {
      const d = doc.data() || {};
      const nom = String(d.name || '').trim();
      if (!nom) return;
      if (d.isAvailable === false || d.isVisible === false) return;
      const prix = Number(d.price);
      tous.push({
        id:          doc.id,
        name:        nom,
        price:       Number.isFinite(prix) && prix > 0 ? prix : null,
        description: d.description ? String(d.description).trim().slice(0, 160) : null,
        category:    d.category ? String(d.category).trim() : null,
        stock:       (typeof d.stock === 'number' && Number.isFinite(d.stock)) ? d.stock : null
      });
    });
    tous.sort((a, b) => a.name.localeCompare(b.name, 'fr'));

    const resultat = {
      lu:       true,
      produits: tous.slice(0, CFG.maxProduits),
      tronque:  tous.length > CFG.maxProduits || snap.size >= CFG.maxLecture
    };
    _cache.set(vendeurId, { ms: maintenant, resultat });
    return resultat;
  } catch (err) {
    console.error(`[boutique-context] Lecture du catalogue impossible (vendeurId=${vendeurId}) :`, err && err.message);
    return { lu: false, produits: [], tronque: false };   // echec non mis en cache : nouvel essai au tour suivant
  }
}

/**
 * Retourne une COPIE du document vendeur enrichie du catalogue reel.
 * Le document d'origine n'est pas modifie (il sert aussi aux controles de plan et de quota).
 */
async function enrichirVendeurPourIA(vendeurId, vendeurData, options = {}) {
  const base = vendeurData || {};
  const cat = await chargerCatalogue(vendeurId, options);
  return Object.assign({}, base, {
    products:          cat.produits,
    _catalogueLu:      cat.lu,
    _catalogueTronque: cat.tronque
  });
}

/**
 * Cherche un produit du catalogue par son nom (tolere accents, majuscules, ponctuation).
 * @returns {{produit: object|null, candidats: object[]}}
 *   produit = correspondance unique ; sinon null et candidats = produits proches (0, ou plusieurs si ambigu).
 */
function trouverProduit(produits, nom) {
  const liste = Array.isArray(produits) ? produits : [];
  const q = normaliser(nom);
  if (!q) return { produit: null, candidats: [] };

  const exacts = liste.filter(p => normaliser(p.name) === q);
  if (exacts.length === 1) return { produit: exacts[0], candidats: exacts };
  if (exacts.length > 1)   return { produit: null, candidats: exacts };

  if (q.length >= 3) {
    const proches = liste.filter(p => {
      const n = normaliser(p.name);
      return n.length >= 3 && (n.includes(q) || q.includes(n));
    });
    if (proches.length === 1) return { produit: proches[0], candidats: proches };
    return { produit: null, candidats: proches };
  }
  return { produit: null, candidats: [] };
}

const MSG = {
  fr: {
    introuvable: (nom) => `Je ne retrouve pas « ${nom} » dans le catalogue de la boutique. Pouvez-vous me préciser le produit souhaité ?`,
    ambigu:      (noms) => `Plusieurs produits correspondent : ${noms}. Lequel souhaitez-vous ?`,
    epuise:      (nom) => `Je suis désolée, « ${nom} » n'est plus en stock pour le moment. Souhaitez-vous un autre produit ?`,
    stockLimite: (nom, n) => `Il ne reste que ${n} exemplaire${n > 1 ? 's' : ''} de « ${nom} ». Souhaitez-vous commander ${n > 1 ? 'cette quantité' : 'cet exemplaire'} ?`,
    totalCorrige:(q, nom, total) => `Pour être précise, le total est de ${total} FCFA pour ${q} × ${nom}. Confirmez-vous cette commande ?`,
    totalImpose: (q, nom, total) => `Votre commande de ${q} × ${nom} est enregistrée, pour un total de ${total} FCFA.`
  },
  en: {
    introuvable: (nom) => `I can't find "${nom}" in the shop catalogue. Could you tell me which product you would like?`,
    ambigu:      (noms) => `Several products match: ${noms}. Which one would you like?`,
    epuise:      (nom) => `I'm sorry, "${nom}" is out of stock at the moment. Would you like another product?`,
    stockLimite: (nom, n) => `Only ${n} unit${n > 1 ? 's are' : ' is'} left of "${nom}". Would you like to order ${n > 1 ? 'that quantity' : 'it'}?`,
    totalCorrige:(q, nom, total) => `To be precise, the total is ${total} FCFA for ${q} × ${nom}. Do you confirm this order?`,
    totalImpose: (q, nom, total) => `Your order of ${q} × ${nom} is registered, for a total of ${total} FCFA.`
  }
};

function _fcfa(n) { return Number(n).toLocaleString('fr-FR'); }

/**
 * Verifie une commande JUSTE AVANT son enregistrement (statut "confirmee" annonce par le modele).
 * Le modele ne peut donc plus enregistrer un produit inexistant, un total faux ou une quantite
 * superieure au stock. N'agit que si le catalogue complet a ete lu.
 *
 * @param {object} vendeurData  copie enrichie (enrichirVendeurPourIA)
 * @param {object} details      details d'intention renvoyes par le modele (produit, quantite, total...)
 * @param {string} statut       statut de commande annonce par le modele
 * @param {string} lang         'fr' | 'en'
 * @param {object} suivi        objet de session { corrections: n } (mutable : evite de boucler)
 * @returns {null | {reponse:string, statutCommande:string, details:object}}
 *          null = aucune correction, on poursuit normalement.
 */
function verifierCommande(vendeurData, details, statut, lang, suivi) {
  if (statut !== 'confirmee') return null;
  if (!vendeurData || vendeurData._catalogueLu !== true || vendeurData._catalogueTronque === true) return null;
  if (!details || !details.produit) return null;

  const M = MSG[lang] || MSG.fr;
  const { produit, candidats } = trouverProduit(vendeurData.products, details.produit);

  if (!produit) {
    const d = Object.assign({}, details, { produit: null, total: 0 });
    if (candidats.length > 1) {
      const noms = candidats.slice(0, 3).map(p => p.name).join(', ');
      return { reponse: M.ambigu(noms), statutCommande: 'en_cours', details: d };
    }
    return { reponse: M.introuvable(String(details.produit).slice(0, 60)), statutCommande: 'en_cours', details: d };
  }

  const q = Math.max(1, Math.floor(Number(details.quantite) || 1));

  if (produit.stock !== null && produit.stock <= 0) {
    return { reponse: M.epuise(produit.name), statutCommande: 'en_cours', details: Object.assign({}, details, { produit: null, total: 0 }) };
  }
  if (produit.stock !== null && q > produit.stock) {
    return { reponse: M.stockLimite(produit.name, produit.stock), statutCommande: 'en_cours',
             details: Object.assign({}, details, { produit: produit.name, quantite: produit.stock, total: produit.price ? produit.price * produit.stock : 0 }) };
  }

  const detailsOk = Object.assign({}, details, { produit: produit.name, quantite: q });
  if (produit.price) {
    const attendu = produit.price * q;
    detailsOk.total = attendu;
    if (Number(details.total) !== attendu) {
      // Le total annonce au client ne vient pas du catalogue : on le corrige et on redemande confirmation.
      // Apres deux corrections, on enregistre avec le total du catalogue en l'annoncant clairement.
      const n = suivi ? (suivi.corrections = (suivi.corrections || 0) + 1) : 1;
      if (n <= 2) return { reponse: M.totalCorrige(q, produit.name, _fcfa(attendu)), statutCommande: 'en_cours', details: detailsOk };
      return { reponse: M.totalImpose(q, produit.name, _fcfa(attendu)), statutCommande: 'confirmee', details: detailsOk };
    }
  }
  return { reponse: null, statutCommande: 'confirmee', details: detailsOk };   // valide : on garde la reponse du modele
}

// ─────────────────────────────────────────────────────────────────────────────
// T-IA-FRESH-01 — Informations mises a jour en cours de conversation
// ─────────────────────────────────────────────────────────────────────────────
// Probleme : le modele recevait ses propres anciennes reponses (« je n'ai pas cette information »)
// et les repetait meme apres que le vendeur ait complete sa FAQ. Chaque reponse de l'assistante
// est maintenant enregistree avec l'empreinte des informations qu'elle avait sous les yeux ; au
// message suivant, toute ancienne reponse dont l'empreinte differe de l'empreinte actuelle est
// marquee comme anterieure a une mise a jour (le prompt dit que les informations actuelles priment).

/** Empreinte stable des informations de la boutique que l'assistante utilise pour repondre. */
function empreinteConnaissance(vendeurData) {
  const v = vendeurData || {};
  const wh = (v.settings && v.settings.workingHours) || null;
  const matiere = {
    faq:  (v.settings && v.settings.iaFAQ || []).map(f => [f && f.q, f && f.r]),
    wh:   wh ? Object.keys(wh).sort().map(j => [j, wh[j] && wh[j].active, wh[j] && wh[j].start, wh[j] && wh[j].end]) : null,
    desc: v.description || v.category || null,
    loc:  v.localisation || null,
    wa:   (v.social && v.social.whatsapp) || null,
    nom:  v.boutiqueName || v.name || null,
    cat:  v._catalogueLu === true ? (v.products || []).map(p => [p.name, p.price, p.stock, p.description, p.category]) : 'illisible',
    tr:   v._catalogueTronque === true
  };
  return crypto.createHash('sha1').update(JSON.stringify(matiere)).digest('hex').slice(0, 12);
}

const ETIQUETTES = {
  fr: '[Réponse donnée avant une mise à jour des informations de la boutique : à revérifier avec les informations actuelles]',
  en: '[Reply given before the shop information was updated: re-check it against the current information]'
};
function etiquetteAncienneReponse(lang) { return ETIQUETTES[lang] || ETIQUETTES.fr; }

/** Retire d'un texte genere toute etiquette recopiee par erreur par le modele. */
function retirerEtiquettes(texte) {
  let t = String(texte == null ? '' : texte);
  for (const e of Object.values(ETIQUETTES)) t = t.split(e).join('');
  return t.replace(/^\s+/, '').trim();
}

/**
 * Historique envoye au modele : les reponses de l'assistante enregistrees avec une autre empreinte
 * (ou sans empreinte, donc anterieures a ce correctif) recoivent l'etiquette.
 * @param {Array<{sender:string,text:string,knowledgeHash?:string}>} messages  documents de la conversation
 */
function historiqueAvecEtiquettes(messages, empreinteActuelle, lang) {
  const etiquette = etiquetteAncienneReponse(lang);
  return (messages || [])
    .map(d => {
      const ia = d.sender === 'ia';
      const texte = d.text || '';
      if (!texte) return null;
      if (ia && d.knowledgeHash !== empreinteActuelle) return { role: 'ia', texte: `${etiquette} ${texte}` };
      return { role: ia ? 'ia' : 'user', texte };
    })
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// T-IA-HANDOFF-01 — « Je transmets au responsable » = une vraie notification
// ─────────────────────────────────────────────────────────────────────────────
const DELAI_DOUBLON_MS = 30 * 60 * 1000;

/**
 * Decide quoi ecrire et quoi notifier quand l'assistante transmet une demande au responsable.
 * Fonction pure (testable) : aucun acces Firestore ni reseau.
 * @param {object} conv      donnees actuelles du document conversation
 * @param {object} details   details renvoyes par le modele (sujet, clientNom, clientTelephone...)
 * @param {number} maintenantMs
 * @returns {{ champs: object, notifier: boolean, titre: string, corps: string }}
 */
function preparerTransmission(conv, details, maintenantMs) {
  const c = conv || {};
  const d = details || {};
  const nom = String(c.clientName || d.clientNom || '').trim().slice(0, 60);
  const tel = String(c.clientPhone || d.clientTelephone || '').trim().slice(0, 30);
  const sujet = String(d.sujet || d.resume || d.question || '').trim().slice(0, 200);

  const precedent = c.aiHandoff || null;
  let precedentMs = 0;
  if (precedent && precedent.at) {
    precedentMs = typeof precedent.at.toMillis === 'function' ? precedent.at.toMillis()
                : (typeof precedent.at.seconds === 'number' ? precedent.at.seconds * 1000 : 0);
  }
  const doublon = !!(precedent && precedent.status === 'pending' && precedentMs && (maintenantMs - precedentMs) < DELAI_DOUBLON_MS);

  const champs = {
    aiHandoff: {
      status: 'pending',
      subject: sujet || (precedent && precedent.subject) || '',
      clientName: nom,
      clientPhone: tel,
      // l'horodatage d'origine est conserve pour un doublon : la fenetre de 30 min ne glisse pas
      at: doublon ? precedent.at : null            // null = a remplacer par serverTimestamp() par l'appelant
    },
    unreadByVendor: true
  };
  const qui = [nom, tel].filter(Boolean).join(' ');
  return {
    champs,
    notifier: !doublon,
    titre: 'Demande à traiter (assistante IA)',
    corps: `${qui || 'Un client'}${sujet ? ' : ' + sujet : ''} - à rappeler`
  };
}

module.exports = { chargerCatalogue, enrichirVendeurPourIA, trouverProduit, verifierCommande, normaliser, _cache, CFG,
                   empreinteConnaissance, etiquetteAncienneReponse, retirerEtiquettes, historiqueAvecEtiquettes, preparerTransmission };
