#!/usr/bin/env node
/**
 * Alinea `minutesLimit` en Firestore con el catálogo y la lógica de trial
 * (misma regla que PlanLimitsService.getEffectiveVoiceMinutesLimit).
 *
 * - Plan de pago: minutos del tier en PLAN_LIMITS.
 * - `gratis` con trial activo: minutos de Starter (45).
 * - `gratis` con trial expirado: 0.
 *
 * Uso (desde la raíz de llamalo-ai-api):
 *   npm run sync:user-minutes
 *   node scripts/sync-user-minutes-from-catalog.js --dry-run
 */

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const TRIAL_MS = 7 * 24 * 60 * 60 * 1000;

/** Debe coincidir con src/common/constants/plans.constants.ts (campo minutesLimit). */
const PLAN_LIMITS = {
  gratis: { minutesLimit: 100 },
  starter: { minutesLimit: 45 },
  growth: { minutesLimit: 200 },
  scale: { minutesLimit: 500 },
};

const LEGACY_FREE_PLAN_SLUGS = ['basic', 'free'];
const LEGACY_PAID_PLAN_SLUGS = { pro: 'starter', premium: 'scale' };
const DEFAULT_PLAN = 'gratis';

function normalizePlanSlug(plan) {
  if (!plan || String(plan).trim() === '') return DEFAULT_PLAN;
  const p = String(plan).trim();
  if (Object.prototype.hasOwnProperty.call(LEGACY_PAID_PLAN_SLUGS, p)) {
    return LEGACY_PAID_PLAN_SLUGS[p];
  }
  if (Object.prototype.hasOwnProperty.call(PLAN_LIMITS, p)) return p;
  if (LEGACY_FREE_PLAN_SLUGS.includes(p)) return DEFAULT_PLAN;
  return DEFAULT_PLAN;
}

function loadServiceAccount() {
  const renderPath = '/etc/secrets/firebase_service_account.json';
  const localPath = path.join(
    __dirname,
    '..',
    'src',
    'config',
    'firebase-service-account.json',
  );
  if (fs.existsSync(renderPath)) {
    return JSON.parse(fs.readFileSync(renderPath, 'utf8'));
  }
  if (fs.existsSync(localPath)) {
    return JSON.parse(fs.readFileSync(localPath, 'utf8'));
  }
  throw new Error('No se encontró el JSON de cuenta de servicio Firebase.');
}

function resolveTrialEndsAtMs(data) {
  const raw = data.trialEndsAt;
  if (raw && typeof raw.toMillis === 'function') return raw.toMillis();
  const created = data.createdAt;
  if (created && typeof created.toMillis === 'function') {
    return created.toMillis() + TRIAL_MS;
  }
  return null;
}

function isTrialActive(data) {
  const plan = normalizePlanSlug(data.plan);
  if (plan !== 'gratis') return false;
  const end = resolveTrialEndsAtMs(data);
  if (end == null) return false;
  return Date.now() < end;
}

function targetMinutesLimit(data) {
  const plan = normalizePlanSlug(data.plan);
  if (plan !== 'gratis') {
    return PLAN_LIMITS[plan].minutesLimit;
  }
  if (isTrialActive(data)) {
    return PLAN_LIMITS.starter.minutesLimit;
  }
  return 0;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.log('🔍 dry-run\n');

  const serviceAccount = loadServiceAccount();
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }

  const db = admin.firestore();
  const snap = await db.collection('users').get();

  let toUpdate = 0;
  let skipped = 0;
  const batches = [];
  let batch = db.batch();
  let ops = 0;

  snap.forEach((doc) => {
    const data = doc.data() || {};
    const target = targetMinutesLimit(data);
    const raw = data.minutesLimit;
    const cur =
      raw === undefined || raw === null ? NaN : Number(raw);
    if (Number.isFinite(cur) && cur === target) {
      skipped++;
      return;
    }

    toUpdate++;
    if (dryRun) {
      console.log(
        `  [dry-run] ${doc.id} plan=${data.plan} → minutesLimit ${cur} → ${target}`,
      );
      return;
    }

    batch.update(doc.ref, { minutesLimit: target });
    ops++;
    if (ops >= 450) {
      batches.push(batch);
      batch = db.batch();
      ops = 0;
    }
  });

  if (!dryRun && ops > 0) batches.push(batch);
  if (!dryRun) {
    for (const b of batches) await b.commit();
  }

  console.log(
    `\n✅ minutesLimit: actualizados ${toUpdate}, ya alineados ${skipped}.`,
  );
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
