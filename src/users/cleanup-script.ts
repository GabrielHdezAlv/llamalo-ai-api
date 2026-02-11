import { getFirestore } from '../firebase/firebase.config';
import * as admin from 'firebase-admin';

/**
 * Script para limpiar blob URLs de la base de datos
 * Ejecutar: npx ts-node src/users/cleanup-script.ts
 */
async function cleanupBlobUrls() {
  const firestore = getFirestore();
  console.log('🧹 Iniciando limpieza de blob URLs...');

  try {
    const usersRef = firestore.collection('users');
    const snapshot = await usersRef.get();

    let cleanedCount = 0;
    const batches: admin.firestore.WriteBatch[] = [];
    let currentBatch = firestore.batch();
    let currentBatchSize = 0;
    const batchSize = 500;

    snapshot.forEach((doc) => {
      const userData = doc.data();

      if (userData.profileImage && userData.profileImage.startsWith('blob:')) {
        console.log(
          `🔍 Encontrada blob URL en usuario ${doc.id}: ${userData.profileImage}`,
        );

        currentBatch.update(doc.ref, {
          profileImage: admin.firestore.FieldValue.delete(),
        });

        cleanedCount++;
        currentBatchSize++;

        if (currentBatchSize >= batchSize) {
          batches.push(currentBatch);
          currentBatch = firestore.batch();
          currentBatchSize = 0;
        }
      }
    });

    if (currentBatchSize > 0) {
      batches.push(currentBatch);
    }

    for (const batch of batches) {
      await batch.commit();
    }

    console.log(
      `✅ Limpieza completada. Se eliminaron ${cleanedCount} blob URLs.`,
    );

    if (cleanedCount > 0) {
      console.log(
        '⚠️  Los usuarios afectados deberán subir sus imágenes de perfil nuevamente.',
      );
    }
  } catch (error) {
    console.error('❌ Error durante la limpieza:', error);
  }
}

if (require.main === module) {
  void cleanupBlobUrls();
}

export { cleanupBlobUrls };
