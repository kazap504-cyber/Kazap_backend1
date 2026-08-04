/**
 * migration-plans.js
 * ─────────────────────────────────────────────────────────────────────────
 * KAZAP — Partie 1/8 : Audit et fiabilisation des données de plan
 * sur les comptes vendeurs existants (collection Firestore 'vendors').
 *
 * Ce script :
 *  - Parcourt tous les documents de 'vendors'.
 *  - Applique EXACTEMENT la même normalisation que kazapP8_normalizePlan
 *    (index.html) / _normaliserPlan (server.js) pour déterminer le plan réel.
 *  - Pour les comptes trial/free SANS planActivatedAt : renseigne
 *    planActivatedAt = createdAt (si connu), pour ne pas offrir un essai
 *    infini ni bloquer le compte à tort.
 *  - Pour les comptes payants (basique/pro/premium) SANS planExpiresAt :
 *    n'invente AUCUNE date. Le compte est listé dans un rapport séparé
 *    « à vérifier manuellement ».
 *  - Journalise (console + fichier) chaque compte modifié / laissé en l'état,
 *    avec la raison.
 *  - Tourne par défaut en mode DRY-RUN (aucune écriture Firestore). Le mode
 *    réel doit être explicitement activé.
 *
 * Contrainte de non-régression : seuls les champs suivants peuvent être
 * touchés, et uniquement sur les comptes trial/free identifiés ci-dessus :
 *   - planActivatedAt
 * Aucun autre champ (produits, commandes, paramètres, plan lui-même, etc.)
 * n'est modifié par ce script.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * UTILISATION
 * ─────────────────────────────────────────────────────────────────────────
 *   Dry-run (par défaut, AUCUNE écriture) :
 *     node migration-plans.js
 *     node migration-plans.js --dry-run
 *
 *   Exécution réelle (écrit dans Firestore) :
 *     node migration-plans.js --apply
 *
 *   Options utiles :
 *     --limit=50        Ne traiter que les 50 premiers documents (tests)
 *     --out=./rapports   Dossier de sortie des rapports (défaut: ./rapports)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PRÉ-REQUIS D'ENVIRONNEMENT (identiques à server.js)
 * ─────────────────────────────────────────────────────────────────────────
 *   FIREBASE_ADMIN_KEY   : JSON du service account (string), OU
 *   GOOGLE_APPLICATION_CREDENTIALS : chemin vers un fichier de credentials.
 *   FIREBASE_PROJECT_ID  : optionnel, défaut 'kazap-f8ff6' (comme server.js).
 *
 *   npm install firebase-admin dotenv
 */

'use strict';

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const admin = require('firebase-admin');

// ═══════════════════════════════════════════════════════════════════════════
// 0. ARGUMENTS CLI
// ═══════════════════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const APPLY   = args.includes('--apply');           // false => dry-run
const DRYRUN  = !APPLY;
const OUT_DIR = (args.find(a => a.startsWith('--out=')) || '--out=./rapports').split('=')[1];
const LIMIT_ARG = args.find(a => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1], 10) : null;

// ═══════════════════════════════════════════════════════════════════════════
// 1. INIT FIREBASE ADMIN (même pattern que server.js)
// ═══════════════════════════════════════════════════════════════════════════

if (!admin.apps.length) {
  let credential;
  if (process.env.FIREBASE_ADMIN_KEY) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_KEY);
    credential = admin.credential.cert(serviceAccount);
  } else {
    // Repli : GOOGLE_APPLICATION_CREDENTIALS ou credentials par défaut de l'environnement.
    credential = admin.credential.applicationDefault();
  }
  admin.initializeApp({
    credential,
    projectId: process.env.FIREBASE_PROJECT_ID || 'kazap-f8ff6'
  });
}

const db = admin.firestore();

// ═══════════════════════════════════════════════════════════════════════════
// 2. NORMALISATION — copie EXACTE de la logique
//    kazapP8_normalizePlan (index.html) / _normaliserPlan (server.js)
// ═══════════════════════════════════════════════════════════════════════════

const VALID_PLANS = ['basique', 'pro', 'premium', 'trial', 'free'];
const PAID_PLANS  = ['basique', 'pro', 'premium'];

/**
 * Reproduit _normaliserPlan (server.js) / la partie "plan" de
 * kazapP8_normalizePlan (index.html) : détermine le plan réel d'un compte
 * SANS modifier le document original (lecture seule).
 */
function normaliserPlan(vendeurData) {
  const raw = vendeurData ? vendeurData.plan : undefined;
  let plan = VALID_PLANS.includes(raw) ? raw : 'free';
  if (plan === 'free' && !(vendeurData && vendeurData.planActivatedAt)) {
    plan = 'trial';
  }
  return plan;
}

/** Convertit un Timestamp Firestore / Date / string en ms epoch, ou null. */
function tsEnMs(ts) {
  if (!ts) return null;
  if (typeof ts.seconds === 'number') return ts.seconds * 1000;
  if (typeof ts.toDate === 'function') return ts.toDate().getTime();
  const d = new Date(ts).getTime();
  return isNaN(d) ? null : d;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. RAPPORT / JOURNALISATION
// ═══════════════════════════════════════════════════════════════════════════

function ensureOutDir() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. TRAITEMENT PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  ensureOutDir();
  const slug = timestampSlug();
  const logPath          = path.join(OUT_DIR, `migration-plans_${slug}.log`);
  const csvPath          = path.join(OUT_DIR, `migration-plans_${slug}.csv`);
  const manualReviewPath = path.join(OUT_DIR, `a-verifier-manuellement_${slug}.csv`);

  const logLines = [];
  const csvRows  = [['vendorId', 'planBrut', 'planNormalise', 'action', 'raison']];
  const manualRows = [['vendorId', 'planNormalise', 'planActivatedAt', 'createdAt', 'raison']];

  function log(msg) {
    console.log(msg);
    logLines.push(msg);
  }

  log('════════════════════════════════════════════════════════════════');
  log(`KAZAP — Audit / migration des plans vendeurs`);
  log(`Mode            : ${DRYRUN ? 'DRY-RUN (aucune écriture)' : 'RÉEL (écriture Firestore)'}`);
  log(`Date            : ${new Date().toISOString()}`);
  log(`Limite          : ${LIMIT ?? 'aucune (collection complète)'}`);
  log('════════════════════════════════════════════════════════════════');

  let query = db.collection('vendors');
  const snapshot = LIMIT ? await query.limit(LIMIT).get() : await query.get();

  log(`Total de comptes lus : ${snapshot.size}`);
  log('');

  let countCoherent = 0;      // (a) déjà cohérents, rien à faire
  let countCorrected = 0;     // (b) trial/free corrigés (planActivatedAt renseigné)
  let countManualReview = 0;  // (c) payants sans planExpiresAt -> vérif manuelle
  let countErrors = 0;

  // Firestore limite un batch à 500 écritures ; on découpe en conséquence.
  const BATCH_LIMIT = 450;
  let batch = db.batch();
  let opsInBatch = 0;

  async function commitBatchIfNeeded(force = false) {
    if (DRYRUN) return;
    if (opsInBatch >= BATCH_LIMIT || force) {
      if (opsInBatch > 0) {
        await batch.commit();
        log(`  → Batch de ${opsInBatch} écriture(s) validé.`);
      }
      batch = db.batch();
      opsInBatch = 0;
    }
  }

  for (const doc of snapshot.docs) {
    const vendorId = doc.id;
    const data = doc.data();

    try {
      const rawPlan = data.plan;
      const plan = normaliserPlan(data);
      const hasPlanActivatedAt = !!data.planActivatedAt;
      const hasPlanExpiresAt   = !!data.planExpiresAt;

      if ((plan === 'trial' || plan === 'free') && !hasPlanActivatedAt) {
        // (b) Compte trial/free sans date d'activation.
        const createdAtMs = tsEnMs(data.createdAt);

        if (createdAtMs) {
          const reason = `plan normalisé='${plan}', planActivatedAt absent → initialisé à createdAt`;
          log(`[CORRIGÉ]  ${vendorId} — ${reason}`);
          csvRows.push([vendorId, rawPlan, plan, 'planActivatedAt <- createdAt', reason]);

          if (!DRYRUN) {
            batch.update(doc.ref, { planActivatedAt: data.createdAt });
            opsInBatch++;
            await commitBatchIfNeeded();
          }
          countCorrected++;
        } else {
          // Pas de createdAt non plus : on ne peut rien inférer sans risque.
          // On ne modifie rien et on signale pour vérification manuelle.
          const reason = `plan normalisé='${plan}', ni planActivatedAt ni createdAt connus — impossible d'inférer une date sans risque`;
          log(`[À VÉRIFIER] ${vendorId} — ${reason}`);
          csvRows.push([vendorId, rawPlan, plan, 'aucune (createdAt absent)', reason]);
          manualRows.push([vendorId, plan, data.planActivatedAt ?? '', data.createdAt ?? '', reason]);
          countManualReview++;
        }
      } else if (PAID_PLANS.includes(plan) && !hasPlanExpiresAt) {
        // (c) Compte payant sans date d'expiration : NE JAMAIS inventer une date.
        const reason = `plan normalisé='${plan}' (payant), planExpiresAt absent — nécessite une vérification manuelle avant toute application du blocage (Partie 3/8)`;
        log(`[À VÉRIFIER] ${vendorId} — ${reason}`);
        csvRows.push([vendorId, rawPlan, plan, 'aucune (payant sans expiration)', reason]);
        manualRows.push([vendorId, plan, data.planActivatedAt ?? '', data.createdAt ?? '', reason]);
        countManualReview++;
      } else {
        // (a) Compte déjà cohérent : rien à faire.
        const reason = `plan normalisé='${plan}', champs de plan déjà cohérents`;
        log(`[OK]       ${vendorId} — ${reason}`);
        csvRows.push([vendorId, rawPlan, plan, 'aucune', reason]);
        countCoherent++;
      }
    } catch (err) {
      countErrors++;
      const reason = `ERREUR lors du traitement : ${err.message}`;
      log(`[ERREUR]   ${vendorId} — ${reason}`);
      csvRows.push([vendorId, data ? data.plan : '', '', 'erreur', reason]);
    }
  }

  await commitBatchIfNeeded(true);

  // ─── Écriture des rapports ────────────────────────────────────────────
  fs.writeFileSync(logPath, logLines.join('\n') + '\n', 'utf8');
  fs.writeFileSync(
    csvPath,
    csvRows.map(r => r.map(csvEscape).join(',')).join('\n') + '\n',
    'utf8'
  );
  fs.writeFileSync(
    manualReviewPath,
    manualRows.map(r => r.map(csvEscape).join(',')).join('\n') + '\n',
    'utf8'
  );

  log('');
  log('════════════════════════════════════════════════════════════════');
  log('RÉSUMÉ');
  log('════════════════════════════════════════════════════════════════');
  log(`(a) Comptes déjà cohérents            : ${countCoherent}`);
  log(`(b) Comptes trial/free corrigés       : ${countCorrected}`);
  log(`(c) Comptes à vérifier manuellement   : ${countManualReview}`);
  log(`Erreurs de traitement                 : ${countErrors}`);
  log(`Total traité                          : ${snapshot.size}`);
  log('');
  log(`Mode                                  : ${DRYRUN ? 'DRY-RUN — aucune écriture effectuée' : 'RÉEL — écritures appliquées'}`);
  log('');
  log(`Rapport détaillé (log)                : ${logPath}`);
  log(`Rapport détaillé (CSV)                : ${csvPath}`);
  log(`Comptes à vérifier manuellement (CSV) : ${manualReviewPath}`);
  log('════════════════════════════════════════════════════════════════');

  if (DRYRUN) {
    log('');
    log('Aucune donnée n\'a été modifiée (mode dry-run).');
    log('Relancez avec --apply après validation du rapport pour appliquer les corrections.');
  }

  // Ré-écrire le log une dernière fois avec le résumé inclus.
  fs.writeFileSync(logPath, logLines.join('\n') + '\n', 'utf8');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Échec du script de migration :', err);
    process.exit(1);
  });
