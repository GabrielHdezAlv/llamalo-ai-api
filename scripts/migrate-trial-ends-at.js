#!/usr/bin/env node
/**
 * Rellena `trialEndsAt` en usuarios que no lo tienen: createdAt + 7 días.
 *
 * Uso: npm run migrate:trial-ends
 *      node scripts/migrate-trial-ends-at.js --dry-run
 */

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const TRIAL_MS = 7 * 24 * 60 * 60 * 1000;

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
    if (data.trialEndsAt != null) {
      skipped++;
      return;
    }
    const created = data.createdAt;
    let trialEndsAt;
    if (created && typeof created.toMillis === 'function') {
      trialEndsAt = admin.firestore.Timestamp.fromMillis(
        created.toMillis() + TRIAL_MS,
      );
    } else {
      trialEndsAt = admin.firestore.Timestamp.fromMillis(
        Date.now() + TRIAL_MS,
      );
    }
    toUpdate++;
    if (dryRun) {
      console.log(`  [dry-run] ${doc.id} trialEndsAt`);
      return;
    }
    batch.update(doc.ref, { trialEndsAt });
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
    `\n✅ trialEndsAt: actualizados ${toUpdate}, ya tenían campo ${skipped}.`,
  );
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
