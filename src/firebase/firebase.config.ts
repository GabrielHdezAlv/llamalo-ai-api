import * as admin from 'firebase-admin';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

let firebaseApp: admin.app.App | null = null;

export function getFirebaseApp(): admin.app.App {
  if (!firebaseApp) {
    try {
      let serviceAccount: admin.ServiceAccount;

      // 🔹 1. Variable de entorno (Render / cualquier hosting con JSON en FIREBASE_SERVICE_ACCOUNT)
      const fromEnv = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
      if (fromEnv) {
        console.log(
          '🔑 Usando credenciales Firebase desde FIREBASE_SERVICE_ACCOUNT',
        );
        serviceAccount = JSON.parse(fromEnv) as admin.ServiceAccount;
      }
      // 🔹 2. Render: secret file montado en /etc/secrets
      else {
        const renderSecretPath = '/etc/secrets/firebase_service_account.json';
        if (existsSync(renderSecretPath)) {
          console.log(
            '📦 Usando credenciales Firebase desde Render secret file',
          );
          serviceAccount = JSON.parse(
            readFileSync(renderSecretPath, 'utf8'),
          ) as admin.ServiceAccount;
        }
        // 🔹 3. Local: archivo en el repo (gitignored)
        else {
          const localPath = join(
            process.cwd(),
            'src/config/firebase-service-account.json',
          );
          console.log('💻 Usando credenciales Firebase locales');
          serviceAccount = JSON.parse(readFileSync(localPath, 'utf8'));
        }
      }

      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      });

      console.log('✅ Firebase inicializado correctamente');
    } catch (error) {
      // 🔒 No loggear el error completo que podría exponer credenciales del serviceAccount
      const errorMessage =
        error instanceof Error ? error.message : 'Error desconocido';
      const errorName = error instanceof Error ? error.name : 'Error';
      console.error(
        `❌ Error al inicializar Firebase: ${errorName} - ${errorMessage}`,
      );
      // No loggear el stack trace completo ni el objeto error completo
      throw error;
    }
  }
  return firebaseApp;
}

export function getFirestore() {
  return getFirebaseApp().firestore();
}
