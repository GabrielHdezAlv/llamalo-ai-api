#!/usr/bin/env node
/**
 * Migra usuarios con plan antiguo `pro` → `starter` y `premium` → `scale`,
 * actualizando `minutesLimit` según el catálogo actual (PLAN_LIMITS).
 *
 * Uso (desde la raíz de llamalo-ai-api):
 *   npm run migrate:legacy-plan-slugs
 *   node scripts/migrate-legacy-paid-plan-slugs.js --dry-run
 */

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const MIGRATION = {
  pro: { plan: 'starter', minutesLimit: 45 },
  premium: { plan: 'scale', minutesLimit: 500 },
};

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
    const p = data.plan;
    if (p !== 'pro' && p !== 'premium') {
      skipped++;
      return;
    }

    const target = MIGRATION[p];
    if (!target) {
      skipped++;
      return;
    }

    toUpdate++;
    const patch = {
      plan: target.plan,
      minutesLimit: target.minutesLimit,
    };

    if (dryRun) {
      console.log(`  [dry-run] ${doc.id} plan: ${p} →`, patch);
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
    `\n✅ Migración slugs de pago. Usuarios a actualizar: ${toUpdate}, sin cambios: ${skipped}.`,
  );
  if (dryRun && toUpdate > 0) {
    console.log('Ejecuta sin --dry-run para aplicar los cambios.');
  }
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
