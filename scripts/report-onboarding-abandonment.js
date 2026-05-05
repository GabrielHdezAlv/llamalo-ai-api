#!/usr/bin/env node
/**
 * Genera un reporte sobre el abandono en el embudo de onboarding.
 *
 * Uso (desde la raíz de llamalo-ai-api):
 *   node scripts/report-onboarding-abandonment.js
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
    'No se encontró el JSON de cuenta de servicio Firebase. Coloca el archivo en src/config/firebase-service-account.json o despliega con secret en Render.',
  );
}

async function main() {
  const serviceAccount = loadServiceAccount();
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }

  const db = admin.firestore();
  console.log('Consultando usuarios...');
  const snap = await db.collection('users').get();

  let totalUsers = 0;
  let completedSetup = 0;
  let abandonedSetup = 0;
  const abandonmentByStep = {
    1: 0,
    2: 0,
    3: 0,
    unknown: 0
  };

  snap.forEach((doc) => {
    const data = doc.data() || {};
    totalUsers++;

    const hasCompleted = data.hasCompletedSetup === true;

    if (hasCompleted) {
      completedSetup++;
    } else {
      abandonedSetup++;
      
      // Intentamos extraer el último paso visitado
      let lastStep = 'unknown';
      if (data.onboardingRegistration && data.onboardingRegistration.lastStep !== undefined) {
        lastStep = data.onboardingRegistration.lastStep;
      } else if (data.lastOnboardingStep !== undefined) {
        // Por si acaso se guardó en la raíz en algún momento
        lastStep = data.lastOnboardingStep;
      } else if (data.onboardingRegistration && data.onboardingRegistration.goals && data.onboardingRegistration.goals.length > 0) {
        // Si tiene goals pero no lastStep, significa que llegó por lo menos al paso 2 o 3 (planes)
        lastStep = 2; // Estimación
      } else {
        // Asumimos que se quedaron en el paso 1 si no hay más info
        lastStep = 1;
      }

      if (abandonmentByStep[lastStep] !== undefined) {
        abandonmentByStep[lastStep]++;
      } else {
        abandonmentByStep[lastStep] = 1;
      }
    }
  });

  console.log('\n📊 === REPORTE DE EMBÚDO DE ONBOARDING ===\n');
  console.log(`Total de usuarios analizados: ${totalUsers}`);
  console.log(`✅ Onboarding completado: ${completedSetup} (${((completedSetup/totalUsers)*100).toFixed(2)}%)`);
  console.log(`❌ Onboarding abandonado: ${abandonedSetup} (${((abandonedSetup/totalUsers)*100).toFixed(2)}%)`);
  
  if (abandonedSetup > 0) {
    console.log('\n🛑 Abandono por paso (usuarios que NO completaron el setup):');
    
    // Ordenar pasos para mostrar
    const steps = Object.keys(abandonmentByStep).sort((a, b) => {
      if (a === 'unknown') return 1;
      if (b === 'unknown') return -1;
      return Number(a) - Number(b);
    });

    for (const step of steps) {
      const count = abandonmentByStep[step];
      if (count > 0 || step !== 'unknown') {
        const percentage = ((count / abandonedSetup) * 100).toFixed(2);
        
        let stepName = `Paso ${step}`;
        if (step === '1') stepName = 'Paso 1 (Pantalla inicial / Bienvenida)';
        if (step === '2') stepName = 'Paso 2 (Formulario: Sector y Tamaño)';
        if (step === '3') stepName = 'Paso 3 (Selección de Plan / Stripe)';
        if (step === 'unknown') stepName = 'Paso Desconocido';
        
        console.log(`  - ${stepName}: ${count} usuarios (${percentage}%)`);
      }
    }
  }

  console.log('\n===========================================\n');
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
