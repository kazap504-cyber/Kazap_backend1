/**
 * KAZAP — phone-utils.js
 * Normalisation des numeros de telephone au format international (E.164, "+22901...").
 *
 * Pourquoi : les SMS (rappels de rendez-vous, confirmations) exigent le format international.
 * Un client qui saisit "0197000000" ou "97000000" est interprete avec le pays du VENDEUR,
 * deduit de son numero d'inscription (champ vendors/{id}.phone, de la forme "+229 90123456").
 *
 * Utilise libphonenumber-js si la bibliotheque est installee (connait tous les plans de
 * numerotation et leurs reformes) ; sinon repli sur des regles internes pour les pays les
 * plus courants. Le module ne plante jamais si la bibliotheque est absente.
 *
 * Benin : depuis la reforme de novembre 2024, les numeros ont 10 chiffres et commencent par
 * "01" (y compris en format international : +229 01 XX XX XX XX). Les anciens numeros a
 * 8 chiffres sont donc completes par "01".
 */

'use strict';

let lib = null;
try { lib = require('libphonenumber-js/max'); } catch (e) {
  try { lib = require('libphonenumber-js'); } catch (e2) { lib = null; }
}

const PAYS_PAR_DEFAUT = String(process.env.KAZAP_DEFAULT_COUNTRY || 'BJ').toUpperCase();

// Indicatifs des pays les plus courants (repli sans bibliotheque)
const INDICATIFS = {
  BJ: '229', TG: '228', CI: '225', SN: '221', ML: '223', BF: '226', NE: '227', GN: '224', GH: '233', NG: '234',
  CM: '237', GA: '241', CG: '242', CD: '243', TD: '235', CF: '236', MR: '222', GM: '220', LR: '231', SL: '232',
  MA: '212', DZ: '213', TN: '216', FR: '33', BE: '32', CH: '41', CA: '1', US: '1', GB: '44', DE: '49', ES: '34', IT: '39', ZA: '27'
};
// Pays ou le "0" initial fait partie du numero (reformes de numerotation) et reste en format international
const ZERO_CONSERVE = new Set(['BJ', 'CI']);
// Prefixes tries du plus long au plus court pour deviner le pays depuis un indicatif
const PAR_INDICATIF = Object.entries(INDICATIFS).sort((a, b) => b[1].length - a[1].length);

function _chiffres(s) { return String(s || '').replace(/\D/g, ''); }

/** Pays (code ISO) deduit du numero d'inscription du vendeur ; Benin par defaut. */
function paysDuVendeur(vendeurData) {
  const tel = vendeurData && typeof vendeurData.phone === 'string' ? vendeurData.phone.trim() : '';
  if (tel) {
    if (lib) {
      try {
        const p = lib.parsePhoneNumberFromString(tel.startsWith('+') || tel.startsWith('00') ? tel.replace(/^00/, '+') : '+' + tel);
        if (p && p.country) return p.country;
      } catch (e) { /* repli */ }
    }
    const brut = tel.replace(/[^\d+]/g, '').replace(/^00/, '+');
    if (brut.startsWith('+')) {
      const d = brut.slice(1);
      const trouve = PAR_INDICATIF.find(([, code]) => d.startsWith(code));
      if (trouve) return trouve[0];
    }
  }
  return PAYS_PAR_DEFAUT;
}

function _longueurOk(e164) {
  const n = e164.length - 1;
  return n >= 8 && n <= 15;
}

/** Benin : complete les anciens numeros a 8 chiffres avec le prefixe "01". */
function _beninNational(chiffresNationaux) {
  if (chiffresNationaux.length === 8) return '01' + chiffresNationaux;
  return chiffresNationaux;
}

/**
 * @param {string} valeur       numero saisi (avec ou sans indicatif, espaces et points tolerés)
 * @param {string} paysDefaut   code ISO du pays a utiliser quand le numero n'a pas d'indicatif
 * @returns {string|null}       numero E.164 ("+22901...") ou null s'il n'est pas utilisable
 */
function normaliserTelephone(valeur, paysDefaut) {
  if (typeof valeur !== 'string') return null;
  const pays = String(paysDefaut || PAYS_PAR_DEFAUT).toUpperCase();
  let brut = valeur.replace(/[^\d+]/g, '');
  if (!brut) return null;
  if (brut.startsWith('00')) brut = '+' + brut.slice(2);

  // ── Numero avec indicatif international ──
  if (brut.startsWith('+')) {
    let chiffres = brut.slice(1).replace(/\D/g, '');
    if (chiffres.startsWith('229')) chiffres = '229' + _beninNational(chiffres.slice(3));   // ancien format +229 XXXXXXXX
    const e164 = '+' + chiffres;
    if (lib) {
      try { const p = lib.parsePhoneNumberFromString(e164); if (p && p.isValid()) return p.number; } catch (e) { /* repli */ }
    }
    return _longueurOk(e164) ? e164 : null;
  }

  // ── Numero local : on utilise le pays du vendeur ──
  let national = brut.replace(/\D/g, '');
  if (pays === 'BJ') national = _beninNational(national.replace(/^229/, ''));
  if (lib) {
    try {
      const p = lib.parsePhoneNumberFromString(national, pays);
      if (p && p.isValid()) return p.number;
    } catch (e) { /* repli */ }
  }
  const code = INDICATIFS[pays];
  if (!code) return null;
  if (!ZERO_CONSERVE.has(pays)) national = national.replace(/^0/, '');   // retire le zero national, sauf Benin et Cote d'Ivoire ou il fait partie du numero
  if (national.startsWith(code) && national.length > code.length + 6) national = national.slice(code.length);
  const e164 = '+' + code + national;
  return _longueurOk(e164) ? e164 : null;
}

module.exports = { normaliserTelephone, paysDuVendeur, PAYS_PAR_DEFAUT, _bibliothequeChargee: () => !!lib };
