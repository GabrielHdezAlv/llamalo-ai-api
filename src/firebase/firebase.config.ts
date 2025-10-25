import * as admin from 'firebase-admin';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

let firebaseApp: admin.app.App | null = null;

export function getFirebaseApp(): admin.app.App {
  if (!firebaseApp) {
    try {
      let serviceAccount: admin.ServiceAccount;

      const renderSecretPath = '/etc/secrets/firebase_service_account.json';

      if (existsSync(renderSecretPath)) {
        console.log('📦 Usando credenciales Firebase desde Render secret file');
        serviceAccount = JSON.parse(readFileSync(renderSecretPath, 'utf8'));
      } else {
        const localPath = join(
          __dirname,
          '../config/llamaloio-firebase-adminsdk-fbsvc-2884e73711.json',
        );
        console.log('💻 Usando credenciales Firebase locales');
        serviceAccount = JSON.parse(readFileSync(localPath, 'utf8'));
      }

      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      });

      console.log('✅ Firebase inicializado correctamente');
    } catch (error) {
      console.error('❌ Error al inicializar Firebase:', error);
      throw error;
    }
  }
  return firebaseApp;
}

export function getFirestore() {
  return getFirebaseApp().firestore();
}
