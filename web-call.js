/**
 * KAZAP — web-call.js
 * Appel vocal dans l'application : le client appelle la boutique depuis le
 * navigateur (boutique publique), l'IA decroche et dialogue avec lui.
 *
 * Chaine audio (sans operateur telephonique, donc sans Twilio) :
 *   micro du navigateur --PCM 16 bits 16 kHz--> WebSocket --> Deepgram (STT)
 *   --> IA (ai-provider) --> texte renvoye au navigateur --> synthese vocale
 *   du navigateur (provisoire, voir "Voix" dans la documentation de phase).
 *
 * Canal vendeur (Phase 3) : le tableau de bord du vendeur ouvre aussi une
 * connexion WebSocket (?mode=vendor&token=<jeton Firebase>). Elle sert a la fois
 * de presence (vendeur connecte) et de canal de sonnerie :
 *   Serveur -> vendeur  {"event":"vendor_ready"}
 *                       {"event":"incoming_call","callSid":"WEB-..","callerName":"..","expiresInSec":20}
 *                       {"event":"call_cancelled","callSid":"WEB-..","reason":"timeout|declined|caller_hung_up|answered_elsewhere|expired"}
 *                       {"event":"accept_failed","callSid":"WEB-.."}
 *   Vendeur -> serveur  {"event":"accept","callSid":".."} | {"event":"decline","callSid":".."}
 *                       {"event":"visibility","visible":true|false} | {"event":"ping"}
 * Sonnerie : active par defaut (WEB_CALL_RING_VENDOR=false pour la desactiver).
 * Si le vendeur est disponible (voip.unavailableMode != true) et joignable
 * (connecte ou notification possible), il est appele pendant 20 s ; sans reponse,
 * ou s'il refuse, l'IA decroche.
 *
 * Conversation vendeur-client (Phase 4) : audio WebRTC direct entre le navigateur
 * du client et le tableau de bord du vendeur. Le serveur ne fait que relayer la
 * signalisation (offre, reponse, candidats ICE) et fournir les serveurs STUN/TURN.
 * Deux entrees dans la conversation humaine :
 *   - le vendeur decroche pendant la sonnerie ("accept") ;
 *   - le vendeur reprend un appel que l'IA est en train de mener ("takeover") :
 *     l'IA prononce alors une phrase de transition, puis le vendeur parle.
 * Si l'audio WebRTC echoue, l'IA reprend l'appel automatiquement.
 *   Serveur -> vendeur  {"event":"ai_call_started","callSid":"..","callerName":".."}
 *                       {"event":"ai_call_line","callSid":"..","who":"client|ia","text":".."}
 *                       {"event":"ai_call_ended","callSid":"..","reason":".."}
 *                       {"event":"call_connected","callSid":"..","mode":"accept|takeover","ice":[..],"summary":[..]}
 *                       {"event":"rtc_offer"|"rtc_ice", ...}   {"event":"call_ended","callSid":"..","reason":".."}
 *   Vendeur -> serveur  {"event":"takeover","callSid":".."}  {"event":"hangup","callSid":".."}
 *                       {"event":"rtc_answer"|"rtc_ice"|"rtc_failed","callSid":"..", ...}
 *   Serveur -> client   {"event":"vendor_joined","mode":"accept|takeover","ice":[..]}
 *                       {"event":"rtc_answer"|"rtc_ice", ...}   {"event":"ai_resumed"}
 *   Client -> serveur   {"event":"rtc_offer"|"rtc_ice"|"rtc_failed", ...}
 * Serveurs TURN (necessaires sur certains reseaux mobiles) : variables TURN_URLS
 * (separees par des virgules) avec soit TURN_USERNAME + TURN_CREDENTIAL, soit
 * TURN_SECRET (identifiants temporaires, format coturn "use-auth-secret").
 *
 * Ce module ne depend d'aucun fichier interne : tout ce dont il a besoin
 * (Firestore, Deepgram, IA, quotas, RDV, notifications) lui est injecte par
 * server.js via creerWebCall(deps). Il reutilise donc exactement les memes
 * regles de plan, de quota et de RDV que l'appel telephonique existant.
 *
 * Protocole (une connexion WebSocket = un appel) :
 *   URL : wss://<backend>/media-stream?mode=web&vendor=<vendeurId>
 *   Client -> serveur
 *     texte  {"event":"start","name":"...","phone":"+229..."}   (nom et numero facultatifs)
 *     texte  {"event":"stop"}                                    (raccrocher)
 *     binaire : trames audio PCM 16 bits little-endian, mono, 16 kHz
 *   Serveur -> client
 *     {"event":"ringing","sec":20}   (le responsable est appele ; l'IA decroche s'il ne repond pas)
 *     {"event":"ready","lang":"fr","maxSec":600}
 *     {"event":"ia_text","text":"...","final":false|true}   (a prononcer)
 *     {"event":"transcript","text":"..."}                    (ce que l'IA a compris)
 *     {"event":"ended","reason":"hangup|quota|max_duration|idle|ia_error|..."}
 *     {"event":"error","code":"...","message":"..."}
 */

'use strict';

const crypto = require('crypto');

// Reglages (surchargeables par variables d'environnement sur Render)
const CFG = {
  maxCallSec:           Number(process.env.WEB_CALL_MAX_SEC) || 600,  // duree maximale d'un appel
  quotaCheckMs:         Number(process.env.WEB_CALL_QUOTA_CHECK_MS) || 30_000,    // controle du quota pendant l'appel
  idleMs:               90_000,    // silence total avant raccrochage automatique
  startTimeoutMs:       15_000,    // delai pour que le client envoie "start"
  keepAliveMs:          5_000,     // maintien de la connexion Deepgram
  maxPerIpConcurrent:   2,         // appels simultanes par adresse IP
  rateWindowMs:         600_000,   // fenetre de limitation de debit
  rateMaxPerIp:         8,         // appels maximum par IP sur la fenetre
  maxFrameBytes:        16_384,    // taille maximale d'une trame audio
  maxConsecutiveIaErrors: 2,       // echecs IA successifs avant fin d'appel
  ringSec:              Number(process.env.WEB_CALL_RING_SEC) || 20,  // sonnerie chez le vendeur avant l'IA
  maxVendorConns:       5,         // connexions simultanees d'un meme vendeur (plusieurs appareils)
  maxHumanSec:          Number(process.env.WEB_CALL_MAX_HUMAN_SEC) || 1800  // duree maximale d'une conversation vendeur-client
};

const PHRASE_TRANSITION = {
  fr: "Bonne nouvelle, le responsable de la boutique est disponible et prend la suite. Je vous le passe, un instant.",
  en: "Good news, the shop manager is available and is taking over. One moment, I'll put you through."
};
const PHRASE_REPRISE_IA = {
  fr: "Nous avons un petit souci de connexion avec le responsable. Je reprends votre appel, comment puis-je vous aider ?",
  en: "We had a small connection problem with the manager. I'm taking your call again, how can I help you?"
};

/** Serveurs STUN/TURN transmis aux deux navigateurs pour la conversation WebRTC. */
function _iceServers(callSid) {
  const serveurs = [{ urls: ['stun:stun.l.google.com:19302'] }];
  const urls = String(process.env.TURN_URLS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (urls.length) {
    if (process.env.TURN_SECRET) {
      const expire = Math.floor(Date.now() / 1000) + 3600;
      const username = `${expire}:${callSid}`;
      const credential = crypto.createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
      serveurs.push({ urls, username, credential });
    } else if (process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
      serveurs.push({ urls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
    }
  }
  return serveurs;
}

const ID_VENDEUR_REGEX = /^[A-Za-z0-9_-]{6,128}$/;

function _nettoyerNom(valeur) {
  if (typeof valeur !== 'string') return null;
  const nom = valeur.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
  return nom || null;
}

/** Garde uniquement un numero au format international (+...) plausible. */
function _nettoyerTelephone(valeur) {
  if (typeof valeur !== 'string') return null;
  let tel = valeur.replace(/[^\d+]/g, '');
  if (tel.startsWith('00')) tel = '+' + tel.slice(2);
  if (!tel.startsWith('+')) return null;
  const chiffres = tel.slice(1).replace(/\D/g, '');
  if (chiffres.length < 8 || chiffres.length > 15) return null;
  return '+' + chiffres;
}

/** Retire les caracteres de mise en forme qui seraient lus a voix haute. */
function _textePourVoix(texte) {
  return String(texte || '').replace(/[*_#`~]/g, '').replace(/\s+/g, ' ').trim();
}

function _ipDepuisRequete(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'inconnue';
}

function creerWebCall(deps) {
  const {
    db, WebSocket,
    traiterAudioStream, fermerDeepgram,
    genererReponseIA, getIAWelcomeMsg,
    ecrireIaOrder, mettreAJourStatutAppel, getCreneauxPourIA,
    RdvBooking, traiterEtapeRdv,
    accesIAAutorise, quotaIADisponible, quotaIADepasseEnCours,
    compteEstBloque, essaiEncoreActif, normaliserPlan,
    notifierCommandeIA, sendFCMPush,
    verifierToken
  } = deps;
  const log = deps.log || console;

  // Limitation d'abus (en memoire : suffisant pour une instance unique)
  const appelsActifsParIp = new Map();   // ip -> nombre d'appels en cours
  const historiqueParIp   = new Map();   // ip -> [horodatages de debut d'appel]

  function _debitAutorise(ip) {
    const maintenant = Date.now();
    const recents = (historiqueParIp.get(ip) || []).filter(t => maintenant - t < CFG.rateWindowMs);
    if (recents.length >= CFG.rateMaxPerIp) { historiqueParIp.set(ip, recents); return false; }
    recents.push(maintenant);
    historiqueParIp.set(ip, recents);
    return true;
  }

  // ── Canal vendeur : presence et sonnerie (Phase 3) ──────────────────────────
  const vendeursEnLigne = new Map();   // vendeurId -> Set de connexions { ws, visible }
  const sonneries       = new Map();   // vendeurId -> sonnerie en cours (une seule a la fois)
  const appelsActifs    = new Map();   // callSid -> session (appels IA et conversations vendeur-client en cours)

  function _sonnerieActive() { return process.env.WEB_CALL_RING_VENDOR !== 'false'; }
  function _vendeurDisponible(vd) { return !(vd && vd.voip && vd.voip.unavailableMode === true); }

  function _connexionsOuvertes(vendeurId) {
    const set = vendeursEnLigne.get(vendeurId);
    return set ? Array.from(set).filter(c => c.ws.readyState === WebSocket.OPEN) : [];
  }
  function _envoyerAuVendeur(vendeurId, obj, sauf) {
    let n = 0;
    _connexionsOuvertes(vendeurId).forEach(c => {
      if (c === sauf) return;
      try { c.ws.send(JSON.stringify(obj)); n++; } catch (e) { /* connexion en cours de fermeture */ }
    });
    return n;
  }
  function _vendeurVisible(vendeurId) { return _connexionsOuvertes(vendeurId).some(c => c.visible); }

  /**
   * Fait sonner le vendeur. Retourne une promesse qui se resout avec l'issue :
   * 'accepted' | 'declined' | 'timeout' | 'caller_hung_up' | 'occupe' | 'injoignable'.
   */
  function sonnerVendeur(session, notifierAppelant) {
    const vendeurId = session.vendeurId;
    // Vendeur deja en train de sonner ou en conversation avec un autre client : l'IA prend ce nouvel appel
    let enConversation = false;
    appelsActifs.forEach((sess) => { if (sess.vendeurId === vendeurId && sess.mode === 'humain' && !sess.termine) enConversation = true; });
    if (sonneries.has(vendeurId) || enConversation) return Promise.resolve('occupe');
    const aUnToken = !!(session.vendeurData && session.vendeurData.fcmToken);
    if (!_connexionsOuvertes(vendeurId).length && !aUnToken) return Promise.resolve('injoignable');

    return new Promise((resolve) => {
      const s = { callSid: session.callSid, session, finMs: Date.now() + CFG.ringSec * 1000, fini: false, timer: null };
      s.terminer = (issue, sauf) => {
        if (s.fini) return;
        s.fini = true;
        clearTimeout(s.timer);
        if (sonneries.get(vendeurId) === s) sonneries.delete(vendeurId);
        session.sonnerie = null;
        const raison = issue === 'accepted' ? 'answered_elsewhere' : issue;
        _envoyerAuVendeur(vendeurId, { event: 'call_cancelled', callSid: s.callSid, reason: raison }, sauf);
        resolve(issue);
      };
      s.timer = setTimeout(() => s.terminer('timeout'), CFG.ringSec * 1000);
      sonneries.set(vendeurId, s);
      session.sonnerie = s;

      notifierAppelant({ event: 'ringing', sec: CFG.ringSec });
      const nom = session.callerNom;
      _envoyerAuVendeur(vendeurId, { event: 'incoming_call', callSid: s.callSid, callerName: nom, expiresInSec: CFG.ringSec });
      // Application fermee ou en arriere-plan : notification push a priorite haute
      if (!_vendeurVisible(vendeurId) && typeof sendFCMPush === 'function') {
        Promise.resolve(sendFCMPush(vendeurId, 'Appel entrant', `${nom || 'Un client'} appelle votre boutique`,
          { type: 'incoming_call', callSid: s.callSid, source: 'web_call' }, { urgent: true }))
          .catch(e => log.warn('[web-call] push appel entrant :', e && e.message));
      }
    });
  }

  function estConnexionVendeur(req) {
    try { return new URL(req.url, 'http://localhost').searchParams.get('mode') === 'vendor'; }
    catch (e) { return false; }
  }

  async function handleVendeur(ws, req) {
    let params;
    try { params = new URL(req.url, 'http://localhost').searchParams; } catch (e) { params = new URLSearchParams(); }
    const envoyer = (obj) => { if (ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify(obj)); } catch (e) { /* ferme */ } } };
    const refuser = (code) => { envoyer({ event: 'error', code }); setTimeout(() => { try { ws.close(); } catch (e) { /* ferme */ } }, 200); };

    const token = params.get('token') || '';
    let vendeurId;
    try {
      if (typeof verifierToken !== 'function' || !token) throw new Error('jeton manquant');
      vendeurId = await verifierToken(token);
      if (!vendeurId) throw new Error('jeton invalide');
    } catch (err) {
      return refuser('unauthorized');
    }
    if (ws.readyState !== WebSocket.OPEN) return;

    let set = vendeursEnLigne.get(vendeurId);
    if (!set) { set = new Set(); vendeursEnLigne.set(vendeurId, set); }
    if (set.size >= CFG.maxVendorConns) return refuser('too_many_connections');
    const conn = { ws, visible: true };
    set.add(conn);

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (e) { return; }
      if (!msg || typeof msg.event !== 'string') return;
      switch (msg.event) {
        case 'ping': envoyer({ event: 'pong' }); break;
        case 'visibility': conn.visible = msg.visible !== false; break;
        case 'accept':
        case 'decline': {
          const s = sonneries.get(vendeurId);
          if (!s || s.fini || s.callSid !== msg.callSid) { envoyer({ event: 'call_cancelled', callSid: msg.callSid, reason: 'expired' }); return; }
          if (msg.event === 'accept') s.session.accepteur = conn;
          s.terminer(msg.event === 'accept' ? 'accepted' : 'declined', conn);
          break;
        }
        case 'takeover': {
          const sess = appelsActifs.get(msg.callSid);
          if (!sess || sess.vendeurId !== vendeurId || sess.termine || sess.mode !== 'ia') {
            envoyer({ event: 'call_cancelled', callSid: msg.callSid, reason: 'expired' });
            return;
          }
          sess.api.entrerModeHumain(conn, 'takeover');
          break;
        }
        case 'hangup':
        case 'rtc_answer':
        case 'rtc_ice':
        case 'rtc_failed': {
          const sess = appelsActifs.get(msg.callSid);
          if (!sess || sess.vendeurConn !== conn || sess.termine || sess.mode !== 'humain') return;
          if (msg.event === 'hangup') sess.api.terminer('vendor_hangup');
          else if (msg.event === 'rtc_failed') sess.api.repriseIA('rtc_failed');
          else sess.api.versAppelant(msg.event === 'rtc_answer' ? { event: 'rtc_answer', sdp: msg.sdp } : { event: 'rtc_ice', candidate: msg.candidate });
          break;
        }
      }
    });
    ws.on('close', () => {
      set.delete(conn);
      if (!set.size) vendeursEnLigne.delete(vendeurId);
      // Le vendeur quitte en pleine conversation : l'IA reprend le client
      appelsActifs.forEach((sess) => {
        if (sess.vendeurConn === conn && sess.mode === 'humain' && !sess.termine) sess.api.repriseIA('vendor_disconnected');
      });
    });
    ws.on('error', (err) => log.error('[web-call] Erreur WebSocket vendeur :', err.message));

    envoyer({ event: 'vendor_ready' });
    // Appels IA deja en cours : le vendeur peut les suivre et les reprendre
    appelsActifs.forEach((sess) => {
      if (sess.vendeurId === vendeurId && sess.mode === 'ia' && !sess.termine) {
        envoyer({ event: 'ai_call_started', callSid: sess.callSid, callerName: sess.callerNom });
      }
    });
    // Le vendeur arrive (par exemple en touchant la notification) pendant une sonnerie : on la lui presente
    const encours = sonneries.get(vendeurId);
    if (encours && !encours.fini) {
      envoyer({ event: 'incoming_call', callSid: encours.callSid, callerName: encours.session.callerNom,
        expiresInSec: Math.max(1, Math.round((encours.finMs - Date.now()) / 1000)) });
    }
  }

  function estConnexionWeb(req) {
    try {
      return new URL(req.url, 'http://localhost').searchParams.get('mode') === 'web';
    } catch (e) {
      return false;
    }
  }

  function handleConnection(ws, req) {
    let params;
    try { params = new URL(req.url, 'http://localhost').searchParams; }
    catch (e) { params = new URLSearchParams(); }

    const vendeurId = params.get('vendor') || '';
    const ip = _ipDepuisRequete(req);

    const send = (obj) => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(obj)); } catch (e) { /* connexion deja fermee */ }
      }
    };
    const refuser = (code, message) => {
      send({ event: 'error', code, message });
      setTimeout(() => { try { ws.close(); } catch (e) { /* deja fermee */ } }, 300);
    };

    if (!ID_VENDEUR_REGEX.test(vendeurId)) { return refuser('bad_request', 'Boutique inconnue.'); }
    if (process.env.WEB_CALL_ENABLED === 'false') { return refuser('disabled', "L'appel dans l'application est désactivé pour le moment."); }
    if ((appelsActifsParIp.get(ip) || 0) >= CFG.maxPerIpConcurrent || !_debitAutorise(ip)) {
      return refuser('rate_limited', 'Trop de tentatives. Réessayez dans quelques minutes.');
    }
    appelsActifsParIp.set(ip, (appelsActifsParIp.get(ip) || 0) + 1);

    const session = {
      vendeurId,
      mode:           'ia',      // 'ia' | 'humain' (conversation vendeur-client)
      vendeurConn:    null,
      accepteur:      null,
      iaAccumMs:      0,         // temps d'IA cumule (seul ce temps compte dans les quotas)
      dureePartielleEcrite: false, // la duree IA deja ecoulee est enregistree dans Firestore (reprise par le vendeur)
      iaSegStartMs:   null,
      agendaCharge:   false,
      ordreCree:      false,
      accueilFait:    false,
      api:            null,
      callSid:        'WEB-' + crypto.randomBytes(8).toString('hex').toUpperCase(),
      callerId:       null,
      callerNom:      null,
      transcription:  '',
      historique:     [],
      vendeurData:    null,
      creneauxAgenda: null,
      lang:           'fr',
      deepgramSocket: null,
      demarrageEnCours: false,
      demarre:        false,
      termine:        false,
      startMs:        null,
      reponseEnCours: false,
      enAttente:      null,
      erreursIaConsecutives: 0,
      commandeEnCours: { produit: null, quantite: null, adresse: null, clientNom: null, total: 0, confirmee: false },
      rdvState: { etape: null, proposals: [], chosenSlot: null, retryCount: 0, clientNom: null, motif: 'Rendez-vous' }
    };
    const timers = { start: null, quota: null, max: null, idle: null, keepAlive: null };
    let ipLiberee = false;

    function libererIp() {
      if (ipLiberee) return;
      ipLiberee = true;
      const n = (appelsActifsParIp.get(ip) || 1) - 1;
      if (n <= 0) appelsActifsParIp.delete(ip); else appelsActifsParIp.set(ip, n);
    }

    function _viderTimers() {
      Object.keys(timers).forEach(k => {
        if (timers[k]) { clearTimeout(timers[k]); clearInterval(timers[k]); timers[k] = null; }
      });
    }

    function _msIa() { return session.iaAccumMs + (session.iaSegStartMs ? Date.now() - session.iaSegStartMs : 0); }

    function _armerIdle() {
      if (session.mode !== 'ia') return;
      if (timers.idle) clearTimeout(timers.idle);
      timers.idle = setTimeout(() => {
        const msg = session.lang === 'en'
          ? "I can't hear you anymore, so I'm ending the call. Feel free to call back anytime."
          : "Je ne vous entends plus, je vais raccrocher. N'hésitez pas à rappeler.";
        terminer('idle', msg);
      }, CFG.idleMs);
    }

    function envoyerIA(texte, final = false, force = false) {
      if (session.mode === 'humain' && !force) return;   // le vendeur a pris la main : l'IA se tait
      const t = _textePourVoix(texte);
      if (!t) return;
      send({ event: 'ia_text', text: t, final });
      if (session.mode === 'ia') _envoyerAuVendeur(vendeurId, { event: 'ai_call_line', callSid: session.callSid, who: 'ia', text: t });
    }

    async function terminer(raison, messageFinal) {
      if (session.termine) return;
      session.termine = true;
      _viderTimers();
      if (session.sonnerie) {
        // L'appelant a raccroche pendant que le vendeur sonnait : appel manque
        const nom = session.callerNom;
        session.sonnerie.terminer('caller_hung_up');
        if (typeof sendFCMPush === 'function') {
          Promise.resolve(sendFCMPush(vendeurId, 'Appel manque', `${nom || 'Un client'} a essaye de vous joindre`,
            { type: 'missed_call', source: 'web_call' }))
            .catch(e => log.warn('[web-call] push appel manque :', e && e.message));
        }
      }
      if (messageFinal) envoyerIA(messageFinal, true);
      send({ event: 'ended', reason: raison });
      try { fermerDeepgram(session.deepgramSocket); } catch (e) { /* ignore */ }
      libererIp();

      // Suivi cote vendeur : fin d'un appel IA suivi, ou fin de la conversation en cours
      appelsActifs.delete(session.callSid);
      if (session.mode === 'ia' && session.demarre) {
        _envoyerAuVendeur(vendeurId, { event: 'ai_call_ended', callSid: session.callSid, reason: raison });
      }
      if (session.vendeurConn && raison !== 'vendor_hangup') {
        try { session.vendeurConn.ws.send(JSON.stringify({ event: 'call_ended', callSid: session.callSid, reason: raison })); } catch (e) { /* ferme */ }
      }

      if (session.demarre) {
        // Seul le temps passe avec l'IA est compte (pas la conversation avec le vendeur)
        const dureeSec = Math.max(0, Math.round(_msIa() / 1000));
        try {
          const maj = {
            statut:        raison === 'quota' ? 'quota_depasse' : 'termine',
            durationSec:   dureeSec,
            transcription: session.transcription.trim() || null
          };
          if (raison === 'quota') {
            maj.details = "Appel interrompu automatiquement : quota d'appel IA atteint pendant l'appel (appel dans l'application).";
          }
          await mettreAJourStatutAppel(session.callSid, maj);
        } catch (e) {
          log.warn('[web-call] mise a jour statut fin d\'appel :', e.message);
        }
      }
      // Laisse au client le temps de recevoir le dernier message avant la fermeture
      setTimeout(() => { try { ws.close(); } catch (e) { /* deja fermee */ } }, 1500);
    }

    // ── Un tour de conversation (client parle -> IA repond) ─────────────────
    async function unTour(texte) {
      const vd = session.vendeurData;

      // Flux RDV deterministe en cours : traite sans repasser par l'IA
      if (session.rdvState.etape) {
        session.historique.push({ role: 'client', texte });
        const rdvResult = await traiterEtapeRdv(session, texte, vendeurId);
        session.historique.push({ role: 'ia', texte: rdvResult.reponse });
        if (session.historique.length > 20) session.historique = session.historique.slice(-20);
        envoyerIA(rdvResult.reponse);
        return;
      }

      let resultat;
      try {
        resultat = await genererReponseIA({
          transcription:  texte,
          vendeurData:    vd,
          historique:     session.historique.slice(),
          creneauxAgenda: session.creneauxAgenda,
          lang:           session.lang
        });
        session.erreursIaConsecutives = 0;
      } catch (err) {
        session.erreursIaConsecutives++;
        log.error('[web-call] Erreur IA :', err.message);
        if (session.erreursIaConsecutives >= CFG.maxConsecutiveIaErrors) {
          const msg = session.lang === 'en'
            ? 'Sorry, our assistant is temporarily unavailable. Please try again later.'
            : "Je suis désolée, notre assistante est momentanément indisponible. Merci de réessayer un peu plus tard.";
          await terminer('ia_error', msg);
        } else {
          envoyerIA(session.lang === 'en'
            ? 'Sorry, I had a small technical problem. Could you repeat, please?'
            : "Excusez-moi, j'ai eu un petit souci technique. Pouvez-vous répéter, s'il vous plaît ?");
        }
        return;
      }

      const { reponse, type, details, statutCommande } = resultat;
      session.historique.push({ role: 'client', texte });
      session.historique.push({ role: 'ia', texte: reponse });
      if (session.historique.length > 20) session.historique = session.historique.slice(-20);

      if (type === 'commande' && details) {
        const c = session.commandeEnCours;
        if (details.produit)   c.produit   = details.produit;
        if (details.quantite)  c.quantite  = details.quantite;
        if (details.adresse)   c.adresse   = details.adresse;
        if (details.clientNom) c.clientNom = details.clientNom;
        if (details.total)     c.total     = details.total;
      }

      // Demarrage du flux RDV : les creneaux annonces viennent de l'agenda reel
      let reponseFinale = reponse;
      if (type === 'rdv' && !session.rdvState.etape) {
        if (!accesIAAutorise(vd)) {
          log.warn(`[web-call] RDV agenda intelligent refuse (plan insuffisant) - vendeurId=${vendeurId}`);
        } else {
          if (details && details.clientNom) session.rdvState.clientNom = details.clientNom;
          if (details && details.motif)     session.rdvState.motif     = details.motif;
          const { slots, text } = await RdvBooking.buildProposals(vendeurId);
          reponseFinale = text;
          if (slots.length > 0) {
            session.rdvState.etape     = 'PROPOSE_CRENEAU';
            session.rdvState.proposals = slots;
            session.historique[session.historique.length - 1].texte = reponseFinale;
          }
        }
      }

      // Le client entend la reponse tout de suite ; les ecritures suivent
      envoyerIA(reponseFinale);

      try {
        if (type === 'commande' && statutCommande === 'confirmee' && !session.commandeEnCours.confirmee) {
          session.commandeEnCours.confirmee = true;
          const c = session.commandeEnCours;
          const ordreId = 'IA-' + Date.now().toString(36).toUpperCase();

          await ecrireIaOrder({
            callSid:       session.callSid,
            vendeurId,
            type:          'commande',
            statut:        'nouveau',
            client:        { nom: c.clientNom || session.callerNom, telephone: session.callerId },
            details:       `Commande ${ordreId} — ${c.quantite}× ${c.produit} — ${Number(c.total).toLocaleString('fr-FR')} FCFA — Livraison : ${c.adresse || 'non précisée'}`,
            transcription: session.transcription.trim(),
            durationSec:   null
          });

          await notifierCommandeIA({
            vendeurId,
            vendeurData: vd,
            ordreId,
            details: { ...c, ...details },
            clientPhone: session.callerId
          });

          await sendFCMPush(
            vendeurId,
            'Nouvelle commande IA',
            `${c.clientNom || session.callerNom || 'Client'} — ${c.quantite}× ${c.produit}`,
            { type: 'commande', source: 'ia_web', clickUrl: '/dashboard?section=commandes' }
          );
          log.log(`[web-call] Commande IA confirmee et enregistree - ${ordreId}`);

        } else if (type === 'commande' && statutCommande === 'annulee') {
          await mettreAJourStatutAppel(session.callSid, {
            statut:  'annulee',
            details: "Commande annulée par le client pendant l'appel"
          });

        } else {
          await mettreAJourStatutAppel(session.callSid, {
            type,
            details:       (details && details.resume) || reponse,
            transcription: session.transcription.trim(),
            statut:        'ia_handled'
          });
          if (type === 'rdv') {
            await sendFCMPush(vendeurId, 'Nouveau RDV IA', (details && details.resume) || reponse,
              { type, source: 'ia_web', clickUrl: '/dashboard?section=agenda' });
          }
        }
      } catch (err) {
        log.error('[web-call] Erreur ecriture apres reponse IA :', err.message);
      }
    }

    // File d'attente : si le client reparle pendant que l'IA reflechit, sa phrase
    // est traitee juste apres au lieu d'etre perdue.
    async function traiterTour(texteInitial) {
      session.reponseEnCours = true;
      let texte = texteInitial;
      try {
        while (texte && !session.termine) {
          session.enAttente = null;
          try { await unTour(texte.trim()); }
          catch (err) { log.error('[web-call] Erreur tour de conversation :', err.message); }
          texte = session.enAttente;
        }
      } finally {
        session.reponseEnCours = false;
        if (!session.termine) _armerIdle();
      }
    }

    function surTranscription(texte, isFinal) {
      if (!texte || !isFinal || session.termine || session.mode !== 'ia') return;
      const t = texte.trim();
      if (!t) return;
      session.transcription += ' ' + t;
      send({ event: 'transcript', text: t });
      _envoyerAuVendeur(vendeurId, { event: 'ai_call_line', callSid: session.callSid, who: 'client', text: t });
      _armerIdle();
      if (session.reponseEnCours) {
        session.enAttente = session.enAttente ? session.enAttente + ' ' + t : t;
        return;
      }
      traiterTour(t);
    }

    // ── Demarrage de l'appel ────────────────────────────────────────────────
    async function demarrer(msg) {
      if (session.demarre || session.demarrageEnCours || session.termine) return;
      session.demarrageEnCours = true;
      if (timers.start) { clearTimeout(timers.start); timers.start = null; }

      session.callerNom = _nettoyerNom(msg && msg.name);
      session.callerId  = _nettoyerTelephone(msg && msg.phone);

      let vd;
      try {
        const snap = await db.collection('vendors').doc(vendeurId).get();
        if (!snap.exists) { libererIp(); return refuser('not_found', 'Cette boutique est introuvable.'); }
        vd = snap.data() || {};
      } catch (err) {
        log.error('[web-call] Lecture vendeur :', err.message);
        libererIp();
        return refuser('server_error', 'Service momentanément indisponible. Réessayez dans un instant.');
      }
      session.vendeurData = vd;
      session.lang = (vd.settings && vd.settings.lang) === 'en' ? 'en' : 'fr';

      // Memes regles que l'appel telephonique (/call/incoming) : reglage vendeur, plan, quota
      let autorise = vd.voip && vd.voip.iaReceptionEnabled === false ? false : true;
      if (autorise && (compteEstBloque(vd) || !accesIAAutorise(vd))) autorise = false;
      if (autorise) {
        try { autorise = await quotaIADisponible(vendeurId, vd); }
        catch (err) { log.error('[web-call] Quota :', err.message); autorise = true; }
      }
      if (!autorise) {
        libererIp();
        return refuser('unavailable', session.lang === 'en'
          ? 'This shop cannot take calls right now.'
          : "Cette boutique ne peut pas prendre d'appel pour le moment.");
      }

      // Vendeur disponible et joignable -> il sonne d'abord ; l'IA decroche
      // s'il ne repond pas, refuse, ou n'est pas joignable.
      if (_sonnerieActive() && _vendeurDisponible(vd)) {
        const issue = await sonnerVendeur(session, send);
        if (session.termine) return;   // l'appelant a raccroche pendant la sonnerie
        if (issue === 'accepted') {
          const conn = session.accepteur;
          if (conn && conn.ws.readyState === WebSocket.OPEN && entrerModeHumain(conn, 'accept')) return;
          log.warn('[web-call] vendeur a decroche mais n\'est plus joignable : repli sur l\'IA');
        }
      }

      await lancerIA(vd, false);
    }

    // ── Entree dans la conversation vendeur-client ───────────────────────────
    function _resumeConversation() {
      return session.historique.slice(-8).map(h => ({ who: h.role === 'client' ? 'client' : 'ia', text: h.texte }));
    }

    function entrerModeHumain(conn, mode) {
      if (session.termine || session.mode === 'humain') return false;
      if (session.iaSegStartMs) { session.iaAccumMs += Date.now() - session.iaSegStartMs; session.iaSegStartMs = null; }
      const etaitIA = session.demarre;
      session.mode = 'humain';
      session.vendeurConn = conn;
      session.reponseEnCours = false;
      session.enAttente = null;
      ['keepAlive', 'quota', 'idle', 'max', 'start'].forEach(k => {
        if (timers[k]) { clearTimeout(timers[k]); clearInterval(timers[k]); timers[k] = null; }
      });
      try { fermerDeepgram(session.deepgramSocket); } catch (e) { /* ignore */ }
      session.deepgramSocket = null;
      appelsActifs.set(session.callSid, session);
      timers.max = setTimeout(() => {
        terminer('max_duration', session.lang === 'en'
          ? 'The maximum call duration has been reached. Goodbye.'
          : "La durée maximale de l'appel est atteinte. Au revoir.");
      }, CFG.maxHumanSec * 1000);

      const ice = _iceServers(session.callSid);
      if (mode === 'takeover') {
        // "interrupt" : le navigateur coupe ce que l'assistante est en train de dire pour annoncer le passage de relais
        const t = _textePourVoix(PHRASE_TRANSITION[session.lang] || PHRASE_TRANSITION.fr);
        send({ event: 'ia_text', text: t, final: false, interrupt: true });
      }
      send({ event: 'vendor_joined', mode, ice });
      try {
        conn.ws.send(JSON.stringify({ event: 'call_connected', callSid: session.callSid, callerName: session.callerNom,
          mode, ice, lang: session.lang, summary: _resumeConversation() }));
      } catch (e) { /* le vendeur vient de partir : repli IA via la fermeture de sa connexion */ }
      // Les autres appareils du vendeur ne voient plus l'appel IA a reprendre
      if (etaitIA) _envoyerAuVendeur(vendeurId, { event: 'ai_call_ended', callSid: session.callSid, reason: 'taken' }, conn);

      if (etaitIA && session.ordreCree) {
        session.dureePartielleEcrite = true;
        Promise.resolve(mettreAJourStatutAppel(session.callSid, {
          statut: 'en_cours',
          durationSec: Math.round(session.iaAccumMs / 1000),
          details: 'Appel repris par le vendeur (conversation directe)'
        })).catch(e => log.warn('[web-call] maj statut reprise :', e && e.message));
      }
      return true;
    }

    // L'audio WebRTC a echoue ou le vendeur est parti : l'IA reprend le client
    async function repriseIA(raison) {
      if (session.termine || session.mode !== 'humain') return;
      const conn = session.vendeurConn;
      session.vendeurConn = null;
      if (conn && conn.ws.readyState === WebSocket.OPEN) {
        try { conn.ws.send(JSON.stringify({ event: 'call_ended', callSid: session.callSid, reason: raison })); } catch (e) { /* ferme */ }
      }
      if (timers.max) { clearTimeout(timers.max); timers.max = null; }
      log.warn(`[web-call] repli sur l'IA (${raison}) - callSid=${session.callSid}`);
      await lancerIA(session.vendeurData, true);
    }

    function versAppelant(obj) { send(obj); }

    session.api = { entrerModeHumain, repriseIA, terminer, versAppelant };
    session.ws = ws;

    // ── Demarrage de l'IA (premier decrochage ou reprise apres la conversation humaine) ──
    async function lancerIA(vd, reprise) {
      // Reprise apres la conversation avec le vendeur : le quota d'IA doit encore le permettre
      if (reprise) {
        // Meme controle que pendant un appel (sans l'arrondi a la minute superieure du controle d'avant-appel) :
        // la duree IA deja ecoulee de CET appel est deja enregistree, on n'ajoute rien.
        let encore = true;
        try { encore = !(await quotaIADepasseEnCours(vendeurId, vd, 0)); } catch (e) { encore = true; }
        if (!encore || session.termine) {
          if (!session.termine) {
            await terminer('quota', session.lang === 'en'
              ? 'Sorry, the voice assistant allowance has been reached. Goodbye.'
              : "Je suis désolée, la durée d'utilisation de l'assistante vocale a été atteinte. Au revoir.");
          }
          return;
        }
      }
      // Agenda en temps reel (3 s maximum), charge une seule fois
      if (!session.agendaCharge) {
        try {
          session.creneauxAgenda = await Promise.race([
            getCreneauxPourIA(vendeurId),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout agenda')), 3000))
          ]);
        } catch (err) {
          log.warn('[web-call] Agenda non disponible :', err.message);
          session.creneauxAgenda = null;
        }
        session.agendaCharge = true;
      }

      // Reconnaissance vocale : PCM 16 bits, 16 kHz
      try {
        session.deepgramSocket = await traiterAudioStream({
          vendorLang:      session.lang,
          encoding:        'linear16',
          sampleRate:      16000,
          onTranscription: surTranscription,
          onErreur:        (err) => log.error('[web-call] Erreur Deepgram :', (err && err.message) || err)
        });
      } catch (err) {
        log.error('[web-call] Deepgram indisponible :', err.message);
        const msg = session.lang === 'en'
          ? 'Voice service unavailable. Please try again later.'
          : 'Le service vocal est indisponible. Réessayez plus tard.';
        if (reprise) { await terminer('stt_unavailable', msg); return; }
        libererIp();
        return refuser('stt_unavailable', msg);
      }
      if (session.termine) { try { fermerDeepgram(session.deepgramSocket); } catch (e) { /* ignore */ } return; }

      session.mode = 'ia';
      session.demarre = true;
      session.iaSegStartMs = Date.now();
      if (!session.startMs) session.startMs = Date.now();
      appelsActifs.set(session.callSid, session);

      if (!session.ordreCree) {
        session.ordreCree = true;
        try {
          await ecrireIaOrder({
            callSid:       session.callSid,
            vendeurId,
            type:          'appel',
            statut:        'en_cours',
            client:        { telephone: session.callerId, nom: session.callerNom },
            details:       'Appel depuis la boutique publique (dans l\'application)',
            transcription: null,
            durationSec:   null
          });
        } catch (err) {
          log.error('[web-call] ecrireIaOrder :', err.message);
        }
      }

      // Maintien de la connexion Deepgram, plafond de duree, controle du quota
      timers.keepAlive = setInterval(() => {
        const dg = session.deepgramSocket;
        if (dg && dg.readyState === WebSocket.OPEN) {
          try { dg.send(JSON.stringify({ type: 'KeepAlive' })); } catch (e) { /* ignore */ }
        }
      }, CFG.keepAliveMs);

      timers.max = setTimeout(() => {
        terminer('max_duration', session.lang === 'en'
          ? 'The maximum call duration has been reached. Thank you, goodbye.'
          : "La durée maximale de l'appel est atteinte. Merci de votre appel, au revoir.");
      }, CFG.maxCallSec * 1000);

      const quotaApplicable = !compteEstBloque(vd) && (essaiEncoreActif(vd) || normaliserPlan(vd) === 'pro');
      if (quotaApplicable) {
        const estEssai = essaiEncoreActif(vd);
        timers.quota = setInterval(async () => {
          if (session.termine || session.mode !== 'ia') return;
          try {
            // Si la duree IA d'avant la reprise du vendeur est deja dans Firestore, on ne compte
            // ici que le segment en cours (sinon elle serait comptee deux fois).
            const segmentSec = session.iaSegStartMs ? Math.floor((Date.now() - session.iaSegStartMs) / 1000) : 0;
            const elapsedSec = session.dureePartielleEcrite ? segmentSec : Math.floor(_msIa() / 1000);
            if (await quotaIADepasseEnCours(vendeurId, vd, elapsedSec)) {
              const msg = estEssai
                ? (session.lang === 'en'
                    ? 'Sorry, the call minutes included in the free trial have been used. Please upgrade your plan to continue. Goodbye.'
                    : "Je suis désolée, les minutes d'appel incluses dans l'essai gratuit ont été atteintes. Merci de votre compréhension. Au revoir.")
                : (session.lang === 'en'
                    ? 'Sorry, the monthly voice assistant allowance has been reached. Goodbye.'
                    : "Je suis désolée, la durée d'utilisation de l'assistante vocale pour ce mois a été atteinte. Au revoir.");
              terminer('quota', msg);
            }
          } catch (err) {
            log.error('[web-call] Controle quota en cours :', err.message);
          }
        }, CFG.quotaCheckMs);
      }

      _armerIdle();

      if (reprise) {
        send({ event: 'ai_resumed', lang: session.lang, maxSec: CFG.maxCallSec });
        let texte = PHRASE_REPRISE_IA[session.lang] || PHRASE_REPRISE_IA.fr;
        if (!session.accueilFait) {
          texte = ((vd.settings && vd.settings.iaWelcomeMsg) || getIAWelcomeMsg(vd.boutiqueName, session.lang)) + ' ' + texte;
        }
        session.accueilFait = true;
        envoyerIA(texte);
      } else {
        _envoyerAuVendeur(vendeurId, { event: 'ai_call_started', callSid: session.callSid, callerName: session.callerNom });
        send({ event: 'ready', lang: session.lang, maxSec: CFG.maxCallSec });
        const accueil = (vd.settings && vd.settings.iaWelcomeMsg)
          || getIAWelcomeMsg(vd.boutiqueName, session.lang);
        session.accueilFait = true;
        envoyerIA(accueil);
      }
    }

    // ── Messages du navigateur ──────────────────────────────────────────────
    timers.start = setTimeout(() => {
      if (!session.demarre && !session.demarrageEnCours) { libererIp(); refuser('timeout', 'Délai de connexion dépassé.'); }
    }, CFG.startTimeoutMs);

    ws.on('message', (data, isBinary) => {
      if (session.termine) return;
      if (isBinary) {
        if (!session.demarre || session.mode !== 'ia' || data.length > CFG.maxFrameBytes) return;
        const dg = session.deepgramSocket;
        if (dg && dg.readyState === WebSocket.OPEN) dg.send(data);
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (e) { return; }
      if (!msg || typeof msg.event !== 'string') return;
      if (msg.event === 'start') {
        demarrer(msg).catch(err => {
          log.error('[web-call] Erreur au demarrage :', err.message);
          libererIp();
          refuser('server_error', 'Service momentanément indisponible.');
        });
      } else if (msg.event === 'stop') {
        terminer('hangup');
      } else if (session.mode === 'humain' && session.vendeurConn) {
        // Signalisation WebRTC du client vers le vendeur
        if (msg.event === 'rtc_offer' && typeof msg.sdp === 'string') {
          try { session.vendeurConn.ws.send(JSON.stringify({ event: 'rtc_offer', callSid: session.callSid, sdp: msg.sdp })); } catch (e) { /* ferme */ }
        } else if (msg.event === 'rtc_ice' && msg.candidate) {
          try { session.vendeurConn.ws.send(JSON.stringify({ event: 'rtc_ice', callSid: session.callSid, candidate: msg.candidate })); } catch (e) { /* ferme */ }
        } else if (msg.event === 'rtc_failed') {
          repriseIA('rtc_failed');
        }
      }
    });

    ws.on('close', () => { terminer('client_closed'); libererIp(); });
    ws.on('error', (err) => log.error('[web-call] Erreur WebSocket :', err.message));
  }

  return {
    estConnexionWeb, handleConnection,
    estConnexionVendeur, handleVendeur,
    _cfg: CFG, _vendeursEnLigne: vendeursEnLigne, _sonneries: sonneries, _appelsActifs: appelsActifs
  };
}

module.exports = { creerWebCall, _nettoyerTelephone, _nettoyerNom, _textePourVoix, _iceServers };
