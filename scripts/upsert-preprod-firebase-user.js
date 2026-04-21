#!/usr/bin/env node
/**
 * Crea o actualiza un usuario en Firebase Auth + Firestore (proyecto preprod).
 * Elimina pending_registrations si el registro quedó a medias (PIN por correo).
 *
 * Requiere JSON de cuenta de servicio del proyecto llamalo-preprod (no uses el de prod).
 *
 * Uso (desde la raíz de llamalo-ai-api):
 *   node scripts/upsert-preprod-firebase-user.js --sa ruta/al/preprod-service-account.json
 *
 * Variables (opcionales, por defecto los valores pedidos para la cuenta de prueba Growth):
 *   --email
 *   --password
 *   --name
 *   --lastname
 *   --country
 */

const fs = require('fs');
const admin = require('firebase-admin');
const bcrypt = require('bcryptjs');

const EXPECTED_PROJECT_ID = 'llamalo-preprod';

/** Alineado con PLAN_LIMITS.growth en src/common/constants/plans.constants.ts */
const GROWTH_MINUTES_LIMIT = 200;

function parseArgs(argv) {
  const out = {
    saPath: null,
    email: 'dev.growth@example.com',
    password: 'Test12345$',
    name: 'Dev',
    lastname: 'Growth',
    country: 'ES',
    marketingConsent: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sa' && argv[i + 1]) {
      out.saPath = argv[++i];
    } else if (a === '--email' && argv[i + 1]) {
      out.email = argv[++i];
    } else if (a === '--password' && argv[i + 1]) {
      out.password = argv[++i];
    } else if (a === '--name' && argv[i + 1]) {
      out.name = argv[++i];
    } else if (a === '--lastname' && argv[i + 1]) {
      out.lastname = argv[++i];
    } else if (a === '--country' && argv[i + 1]) {
      out.country = argv[++i];
    }
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv);
  const saPath =
    opts.saPath ||
    process.env.FIREBASE_PREPROD_SERVICE_ACCOUNT_PATH ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (!saPath || !fs.existsSync(saPath)) {
    console.error(
      'Indica el JSON de preprod: node scripts/upsert-preprod-firebase-user.js --sa /ruta/llamalo-preprod-sa.json',
    );
    console.error(
      '(o exporta FIREBASE_PREPROD_SERVICE_ACCOUNT_PATH / GOOGLE_APPLICATION_CREDENTIALS)',
    );
    process.exit(1);
  }

  const serviceAccount = JSON.parse(fs.readFileSync(saPath, 'utf8'));
  if (serviceAccount.project_id !== EXPECTED_PROJECT_ID) {
    console.error(
      `Este script solo admite project_id "${EXPECTED_PROJECT_ID}". Recibido: ${serviceAccount.project_id}`,
    );
    process.exit(1);
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }

  const auth = admin.auth();
  const db = admin.firestore();
  const { email, password, name, lastname, country, marketingConsent } = opts;

  let uid;
  try {
    const existing = await auth.getUserByEmail(email);
    uid = existing.uid;
    await auth.updateUser(uid, {
      emailVerified: true,
      password,
      displayName: `${name} ${lastname}`.trim(),
    });
    console.log(`✅ Usuario Auth existente actualizado: ${uid}`);
  } catch (e) {
    if (e.code === 'auth/user-not-found') {
      const created = await auth.createUser({
        email,
        password,
        emailVerified: true,
        displayName: `${name} ${lastname}`.trim(),
      });
      uid = created.uid;
      console.log(`✅ Usuario Auth creado: ${uid}`);
    } else {
      throw e;
    }
  }

  const pendingRef = db.collection('pending_registrations').doc(uid);
  const pendingSnap = await pendingRef.get();
  if (pendingSnap.exists) {
    await pendingRef.delete();
    console.log('✅ Eliminado pending_registrations para este uid');
  }

  const nowTs = admin.firestore.Timestamp.now();
  const hashedPassword = await bcrypt.hash(password, 10);
  const trialEndsAt = admin.firestore.Timestamp.fromMillis(
    nowTs.toMillis() + 7 * 24 * 60 * 60 * 1000,
  );

  const userDoc = {
    userId: uid,
    profileImage: '',
    name,
    lastname,
    enterprise: { name: '', url: '' },
    email,
    password: hashedPassword,
    country,
    marketingConsent,
    accountStatus: 1,
    rol: 'client_user',
    verificationToken: null,
    verificationTokenExpiresAt: null,
    emailVerifiedAt: nowTs,
    createdAt: nowTs,
    trialEndsAt,
    plan: 'growth',
    minutesLimit: GROWTH_MINUTES_LIMIT,
    extraMinutes: 0,
    integrations: { shopify: [] },
    twilio: [],
    phoneNumbers: [],
    agents: [],
    hasCompletedSetup: true,
    planSelectionCompleted: true,
    trustedDeviceIds: [],
  };

  await db.collection('users').doc(uid).set(userDoc);
  console.log(
    `✅ Firestore users/${uid} guardado: plan=growth, hasCompletedSetup=true, planSelectionCompleted=true`,
  );
  console.log(`   Email: ${email}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
