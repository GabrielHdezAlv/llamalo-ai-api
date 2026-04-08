#!/usr/bin/env node
/**
 * Asigna `plan: gratis` y, si falta, `minutesLimit` según el plan gratuito.
 * Migra el slug legacy `basic` → `gratis`.
 *
 * Uso (desde la raíz de llamalo-ai-api):
 *   node scripts/migrate-user-plans.js
 *   node scripts/migrate-user-plans.js --dry-run
 */

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const DEFAULT_FREE_PLAN = 'gratis';
const FREE_MINUTES_LIMIT = 100;

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
    console.log('📦 Credenciales: Render secret file');
    return JSON.parse(fs.readFileSync(renderPath, 'utf8'));
  }
  if (fs.existsSync(localPath)) {
    console.log('💻 Credenciales: src/config/firebase-service-account.json');
    return JSON.parse(fs.readFileSync(localPath, 'utf8'));
  }
  throw new Error(
    'No se encontró el JSON de cuenta de servicio Firebase. Coloca el archivo en src/config/firebase-service-account.json o despliega con secret en Render.',
  );
}

function needsPlan(data) {
  const p = data.plan;
  return p === undefined || p === null || String(p).trim() === '';
}

function needsMinutesLimit(data) {
  const m = data.minutesLimit;
  return m === undefined || m === null || Number.isNaN(Number(m));
}

function isLegacyBasicPlan(data) {
  return data.plan === 'basic';
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) {
    console.log('🔍 Modo dry-run: no se escribirá en Firestore.\n');
  }

  const serviceAccount = loadServiceAccount();
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
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
    const patch = {};

    if (needsPlan(data)) {
      patch.plan = DEFAULT_FREE_PLAN;
    }
    if (needsMinutesLimit(data)) {
      patch.minutesLimit = FREE_MINUTES_LIMIT;
    }
    if (isLegacyBasicPlan(data)) {
      patch.plan = DEFAULT_FREE_PLAN;
    }

    if (Object.keys(patch).length === 0) {
      skipped++;
      return;
    }

    toUpdate++;
    if (dryRun) {
      console.log(`  [dry-run] ${doc.id} →`, patch);
      return;
    }

    batch.update(doc.ref, patch);
    ops++;
    if (ops >= 450) {
      batches.push(batch);
      batch = db.batch();
      ops = 0;
    }
  });

  if (!dryRun && ops > 0) {
    batches.push(batch);
  }

  if (!dryRun) {
    for (const b of batches) {
      await b.commit();
    }
  }

  console.log(
    `\n✅ Hecho. Documentos a actualizar: ${toUpdate}, sin cambios necesarios: ${skipped}.`,
  );
  if (dryRun && toUpdate > 0) {
    console.log('Ejecuta sin --dry-run para aplicar los cambios.');
  }
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
