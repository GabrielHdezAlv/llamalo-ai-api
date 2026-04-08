#!/usr/bin/env node
/**
 * Crea o actualiza la colección Firestore `plans` (documentos: gratis, pro, premium).
 * Los ids coinciden con `user.plan` y con PLAN_LIMITS en el código.
 *
 * Uso (desde la raíz del API):
 *   npm run seed:plans
 *   node scripts/seed-plans-collection.js --dry-run
 */

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

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
    'No se encontró el JSON de cuenta de servicio Firebase.',
  );
}

const PLANS = [
  {
    id: 'gratis',
    name: 'Gratis',
    minutesLimit: 100,
    price: 0,
    currency: 'EUR',
    sortOrder: 1,
  },
  {
    id: 'pro',
    name: 'Pro',
    minutesLimit: 500,
    price: 29,
    currency: 'EUR',
    sortOrder: 2,
  },
  {
    id: 'premium',
    name: 'Premium',
    minutesLimit: 2000,
    price: 99,
    currency: 'EUR',
    sortOrder: 3,
  },
];

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
  const batch = db.batch();

  for (const p of PLANS) {
    const ref = db.collection('plans').doc(p.id);
    const payload = {
      id: p.id,
      name: p.name,
      minutesLimit: p.minutesLimit,
      price: p.price,
      currency: p.currency,
      sortOrder: p.sortOrder,
      active: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (dryRun) {
      console.log(`  [dry-run] plans/${p.id}`, payload);
    } else {
      batch.set(ref, payload, { merge: true });
    }
  }

  if (!dryRun) {
    await batch.commit();
  }

  console.log(
    `\n✅ Colección \`plans\`: ${PLANS.length} documento(s) ${dryRun ? '(simulado)' : 'escritos/actualizados'}.`,
  );
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
