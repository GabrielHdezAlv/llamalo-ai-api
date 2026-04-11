#!/usr/bin/env node
/**
 * Crea o actualiza la colección Firestore `plans` (documentos: gratis, starter, growth, scale).
 * Los ids coinciden con `user.plan` y con PLAN_LIMITS en el código.
 * Elimina documentos obsoletos `pro` y `premium` si existían.
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
    extraPerMinuteEur: 0,
    agents: 1,
    indexedUrls: 0,
    documentsMax: 0,
    maxDocSizeMb: 0,
    storageTotalMb: 0,
    panelAnalytics: '—',
    integrations: '—',
    support: '—',
    betaAccess: false,
  },
  {
    id: 'starter',
    name: 'Starter',
    minutesLimit: 45,
    price: 29,
    currency: 'EUR',
    sortOrder: 2,
    extraPerMinuteEur: 0.23,
    agents: 1,
    indexedUrls: 10,
    documentsMax: 5,
    maxDocSizeMb: 10,
    storageTotalMb: 100,
    panelAnalytics: 'Básico',
    integrations: 'Make (próximamente)',
    support: 'Email',
    betaAccess: false,
  },
  {
    id: 'growth',
    name: 'Growth',
    minutesLimit: 200,
    price: 79,
    currency: 'EUR',
    sortOrder: 3,
    extraPerMinuteEur: 0.2,
    agents: 2,
    indexedUrls: 50,
    documentsMax: 20,
    maxDocSizeMb: 15,
    storageTotalMb: 400,
    panelAnalytics: 'Avanzado',
    integrations: 'Shopify / WooCommerce, Make (próximamente)',
    support: 'Prioritario',
    betaAccess: false,
  },
  {
    id: 'scale',
    name: 'Scale',
    minutesLimit: 500,
    price: 169,
    currency: 'EUR',
    sortOrder: 4,
    extraPerMinuteEur: 0.18,
    agents: 5,
    indexedUrls: 150,
    documentsMax: 60,
    maxDocSizeMb: 25,
    storageTotalMb: 1536,
    panelAnalytics: 'Completo + exportación',
    integrations:
      'Shopify / WooCommerce, Make (próximamente), CRM + webhooks',
    support: 'Dedicado',
    betaAccess: true,
  },
];

const OBSOLETE_PLAN_IDS = ['pro', 'premium'];

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
      extraPerMinuteEur: p.extraPerMinuteEur,
      agents: p.agents,
      indexedUrls: p.indexedUrls,
      documentsMax: p.documentsMax,
      maxDocSizeMb: p.maxDocSizeMb,
      storageTotalMb: p.storageTotalMb,
      panelAnalytics: p.panelAnalytics,
      integrations: p.integrations,
      support: p.support,
      betaAccess: p.betaAccess,
      active: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (dryRun) {
      console.log(`  [dry-run] plans/${p.id}`, payload);
    } else {
      batch.set(ref, payload, { merge: true });
    }
  }

  for (const oldId of OBSOLETE_PLAN_IDS) {
    const ref = db.collection('plans').doc(oldId);
    if (dryRun) {
      console.log(`  [dry-run] delete plans/${oldId}`);
    } else {
      batch.delete(ref);
    }
  }

  if (!dryRun) {
    await batch.commit();
  }

  console.log(
    `\n✅ Colección \`plans\`: ${PLANS.length} documento(s) ${dryRun ? '(simulado)' : 'escritos/actualizados'}, obsoletos eliminados: ${OBSOLETE_PLAN_IDS.join(', ')}.`,
  );
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
