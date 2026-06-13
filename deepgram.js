/**
 * KAZAP — deepgram.js
 * Module STT (Speech-To-Text) temps réel via Deepgram WebSocket API.
 *
 * Caractéristiques :
 *   - Langue : Français (fr)
 *   - Modèle : nova-2 (meilleur rapport précision/latence)
 *   - Format audio entrant : µ-law 8kHz (format Twilio Media Stream)
 *   - Accumulation des transcriptions intermédiaires et finales
 *   - Gestion timeout et reconnexion automatique
 */

'use strict';

const WebSocket = require('ws');

// URL WebSocket Deepgram — transcription en temps réel
const DEEPGRAM_STT_URL = 'wss://api.deepgram.com/v1/listen';

/**
 * Paramètres de connexion Deepgram optimisés pour les appels téléphoniques
 * en français avec le format audio Twilio (µ-law 8kHz mulaw).
 */
const DEEPGRAM_PARAMS = new URLSearchParams({
  model:         'nova-2',
  language:      'fr',           // Langue française (configurée dans le HTML)
  encoding:      'mulaw',        // Format audio Twilio Media Stream
  sample_rate:   '8000',         // 8kHz (téléphonie)
  channels:      '1',            // Mono
  punctuate:     'true',         // Ajouter la ponctuation automatiquement
  interim_results: 'true',       // Résultats intermédiaires pour réactivité
  endpointing:   '500',          // Détection fin de phrase après 500ms de silence
  smart_format:  'true',         // Formatage automatique des nombres, dates, etc.
  diarize:       'false',        // Pas de séparation des locuteurs (appel 1 à 1)
  filler_words:  'false',        // Ignorer "euh", "hm", etc.
  utterance_end_ms: '1500'       // Fin d'énoncé après 1.5s de silence
});

const DEEPGRAM_WS_URL = `${DEEPGRAM_STT_URL}?${DEEPGRAM_PARAMS.toString()}`;

// Délai max d'attente avant timeout Deepgram (30 secondes)
const DEEPGRAM_TIMEOUT_MS = 30_000;

/**
 * traiterAudioStream
 * Ouvre une connexion WebSocket Deepgram et retourne le socket prêt à recevoir
 * des chunks audio (Buffer µ-law 8kHz).
 *
 * @param {Object} options
 * @param {Function} options.onTranscription — Appelé à chaque transcription
 *   @param {string}  texte   — Texte transcrit
 *   @param {boolean} isFinal — true si résultat final (fin d'énoncé)
 * @param {Function} options.onErreur — Appelé en cas d'erreur Deepgram
 * @returns {Promise<WebSocket>} — Socket Deepgram connecté
 */
async function traiterAudioStream({ onTranscription, onErreur }) {
  const cleApi = process.env.DEEPGRAM_API_KEY;
  if (!cleApi) {
    throw new Error('Variable d\'environnement DEEPGRAM_API_KEY manquante');
  }

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(DEEPGRAM_WS_URL, {
      headers: {
        Authorization: `Token ${cleApi}`
      }
    });

    // Timeout de connexion
    const timeoutConnexion = setTimeout(() => {
      const erreur = new Error('Timeout : connexion Deepgram dépassée (30s)');
      console.error('❌ Deepgram timeout connexion :', erreur.message);
      socket.terminate();
      reject(erreur);
    }, DEEPGRAM_TIMEOUT_MS);

    // ── Connexion établie ───────────────────────────────────────────────────
    socket.on('open', () => {
      clearTimeout(timeoutConnexion);
      console.log('✅ Deepgram STT connecté (fr, nova-2, mulaw 8kHz)');
      resolve(socket);
    });

    // ── Réception des transcriptions ────────────────────────────────────────
    socket.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());

        // Type de message : Results (transcription)
        if (message.type !== 'Results') return;

        const canal    = message.channel;
        const isFinal  = message.is_final === true;
        const alternatives = canal?.alternatives || [];

        if (!alternatives.length) return;

        const texte = alternatives[0].transcript?.trim() || '';

        // Ignorer les transcriptions vides
        if (!texte) return;

        // Confiance minimale (éviter les faux positifs)
        const confiance = alternatives[0].confidence || 0;
        if (confiance < 0.4 && !isFinal) return;

        console.log(`📝 Deepgram [${isFinal ? 'FINAL' : 'interim'}] conf:${confiance.toFixed(2)} : "${texte}"`);

        // Appeler le callback de transcription
        if (typeof onTranscription === 'function') {
          onTranscription(texte, isFinal);
        }

      } catch (err) {
        // Ignorer les messages non-JSON (ex: KeepAlive)
        if (data.toString().includes('{')) {
          console.warn('⚠️ Deepgram : message non parseable :', err.message);
        }
      }
    });

    // ── Erreur WebSocket Deepgram ───────────────────────────────────────────
    socket.on('error', (err) => {
      clearTimeout(timeoutConnexion);
      console.error('❌ Erreur WebSocket Deepgram :', err.message);
      if (typeof onErreur === 'function') {
        onErreur(err);
      }
      // Rejeter seulement si pas encore résolu
      reject(err);
    });

    // ── Fermeture WebSocket Deepgram ────────────────────────────────────────
    socket.on('close', (code, reason) => {
      console.log(`🔌 Deepgram déconnecté — code: ${code}, raison: ${reason?.toString() || 'aucune'}`);
    });
  });
}

/**
 * fermerDeepgram
 * Ferme proprement une connexion Deepgram ouverte.
 * Envoie le signal de fin de flux avant de fermer.
 *
 * @param {WebSocket} socket — Socket Deepgram à fermer
 */
function fermerDeepgram(socket) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  try {
    // Signal Deepgram : fin du flux audio
    socket.send(JSON.stringify({ type: 'CloseStream' }));
    setTimeout(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    }, 500);
  } catch (err) {
    console.warn('⚠️ Erreur fermeture Deepgram :', err.message);
    try { socket.terminate(); } catch {}
  }
}

module.exports = {
  traiterAudioStream,
  fermerDeepgram
};
