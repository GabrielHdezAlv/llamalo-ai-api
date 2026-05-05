const admin = require('firebase-admin');
const { readFileSync, existsSync } = require('fs');
const { join } = require('path');

if (!admin.apps.length) {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        // Usa la variable de entorno nativa de Google
        admin.initializeApp();
    } else {
        let serviceAccount;
        const renderSecretPath = '/etc/secrets/firebase_service_account.json';
        
        if (existsSync(renderSecretPath)) {
            console.log('📦 Usando credenciales Firebase desde Render secret file');
            serviceAccount = JSON.parse(readFileSync(renderSecretPath, 'utf8'));
        } else {
            const localPath = join(process.cwd(), 'src/config/firebase-service-account.json');
            console.log('💻 Usando credenciales Firebase locales (default dev)');
            serviceAccount = JSON.parse(readFileSync(localPath, 'utf8'));
        }

        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount)
        });
    }
}

const db = admin.firestore();

async function removeTrialEndsAtFromIncomplete() {
  console.log('Iniciando script para remover trialEndsAt de usuarios incompletos...');
  
  try {
    const usersSnapshot = await db.collection('users')
      .where('planSelectionCompleted', '==', false)
      .get();
      
    if (usersSnapshot.empty) {
      console.log('No se encontraron usuarios con planSelectionCompleted = false');
      return;
    }
    
    console.log(`Se encontraron ${usersSnapshot.size} usuarios incompletos. Evaluando...`);
    
    const batch = db.batch();
    let updatedCount = 0;
    
    for (const doc of usersSnapshot.docs) {
      const data = doc.data();
      
      if (data.trialEndsAt) {
        console.log(`Borrando trialEndsAt para usuario: ${doc.id}`);
        batch.update(doc.ref, { 
          trialEndsAt: admin.firestore.FieldValue.delete() 
        });
        updatedCount++;
      }
    }
    
    if (updatedCount > 0) {
      console.log(`Ejecutando batch para actualizar ${updatedCount} usuarios...`);
      await batch.commit();
      console.log('✅ Actualización completada con éxito.');
    } else {
      console.log('Ningún usuario incompleto tenía trialEndsAt. No se requiere actualización.');
    }
    
  } catch (error) {
    console.error('Error durante la ejecución del script:', error);
  } finally {
    process.exit(0);
  }
}

removeTrialEndsAtFromIncomplete();
