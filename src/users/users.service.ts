import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import * as admin from 'firebase-admin';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { getFirestore } from '../firebase/firebase.config';

interface PhoneNumber {
  phoneId: number;
  countryCode: string;
  number: string;
  state: 'Activo' | 'Inactivo';
  importedBy: string;
}

interface Agent {
  name: string;
  type: 'outbound' | 'inbound';
  language: string;
  voiceId: string;
  firstInteraction: string;
  agentInstruction: string;
  phoneNumbers: PhoneNumber;
  label: string;
  state: 'Activo' | 'Inactivo';
  parameters: {
    stability: number;
    similarity: number;
    style: number;
    boost: boolean;
    speed: number;
  };
  totalMinutes: number;
}

interface UserData {
  userId?: string;
  profileImage?: string;
  name?: string;
  lastname?: string;
  enterprise?: {
    name: string;
    url: string;
  };
  email?: string;
  password?: string;
  country?: string;
  marketingConsent?: boolean;
  accountStatus?: number;
  createdAt?: admin.firestore.Timestamp | string;
  scheduledDeletionDate?: admin.firestore.Timestamp;
  integrations?: {
    shopify?: {
      connected: boolean;
      shopDomain: string;
    };
  };
  twilio?: {
    twilioSid: string;
    twilioToken: string;
  };
  phoneNumbers?: PhoneNumber[];
  agents?: Agent[];
}

export type UserProfileResponse = {
  userId: string;
  name?: string;
  lastname?: string;
  profileImage?: string;
  enterprise?: {
    name: string;
    url: string;
  };
  email?: string;
  country?: string;
  marketingConsent?: boolean;
  accountStatus?: number;
  createdAt?: string | null;
  twilio?: {
    twilioSid: string;
    twilioToken: string;
  };
  agent?: Record<string, unknown>;
  integrations?: {
    shopify?: {
      connected: boolean;
      shopDomain: string;
    };
  };
  phoneNumbers?: Array<{
    phoneId: number;
    countryCode: string;
    number: string;
    state: 'Activo' | 'Inactivo';
    importedBy: string;
  }>;
  agents?: Array<{
    name: string;
    type: 'outbound' | 'inbound';
    language: string;
    voiceId: string;
    firstInteraction: string;
    agentInstruction: string;
    phoneNumbers: {
      phoneId: number;
      countryCode: string;
      number: string;
    };
    label: string;
    state: 'Activo' | 'Inactivo';
    parameters: {
      stability: number;
      similarity: number;
      style: number;
      boost: boolean;
      speed: number;
    };
    totalMinutes: number;
  }>;
};

export interface UploadFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

@Injectable()
export class UsersService {
  private firestore = getFirestore();
  private storage = admin.storage();

  // Helper para calcular el estado de un phoneNumber basado en si algún agente lo usa
  private calculatePhoneNumberState(
    phoneId: number,
    agents: Agent[] | undefined,
  ): 'Activo' | 'Inactivo' {
    if (!agents || agents.length === 0) {
      return 'Inactivo';
    }
    const isUsed = agents.some(
      (agent) => agent.phoneNumbers?.phoneId === phoneId,
    );
    return isUsed ? 'Activo' : 'Inactivo';
  }

  // ✅ Obtener perfil del usuario
  async getUserProfile(userId: string): Promise<UserProfileResponse> {
    try {
      const docRef = this.firestore.collection('users').doc(userId);
      const snapshot = await docRef.get();

      if (!snapshot.exists) {
        throw new NotFoundException('Usuario no encontrado en Firestore');
      }

      const userData = snapshot.data() as UserData;

      // ✅ Convertir createdAt a string legible
      let createdAtStr: string | null = null;
      const rawData = snapshot.data() as Record<string, unknown>;
      if (rawData?.createdAt) {
        const tsObj = rawData.createdAt as admin.firestore.Timestamp;
        if (tsObj && typeof tsObj.toDate === 'function') {
          const date = tsObj.toDate();
          createdAtStr =
            date.toLocaleDateString('es-ES', {
              day: '2-digit',
              month: 'long',
              year: 'numeric',
            }) +
            ', ' +
            date.toLocaleTimeString('es-ES', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false,
            });
        }
      }

      return {
        userId,
        name: userData?.name,
        lastname: userData?.lastname,
        profileImage: userData?.profileImage,
        enterprise: userData?.enterprise || { name: '', url: '' },
        email: userData?.email,
        country: userData?.country,
        marketingConsent: userData?.marketingConsent,
        accountStatus: userData?.accountStatus,
        createdAt: createdAtStr,
        twilio: userData?.twilio,
        agent: (userData?.agents?.[0] || {}) as Record<string, unknown>, // Compatibilidad: devolver primer agente como agent
        // Nuevos campos
        integrations: userData?.integrations,
        phoneNumbers: (userData?.phoneNumbers || []).map((phone) => ({
          ...phone,
          state: this.calculatePhoneNumberState(
            phone.phoneId,
            userData?.agents,
          ),
          importedBy: phone.importedBy || 'Twilio',
        })),
        agents: userData?.agents || [],
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new BadRequestException(
        `Error al obtener el perfil del usuario: ${(error as Error).message}`,
      );
    }
  }

  // ✅ Actualizar perfil del usuario
  async updateUserProfile(userId: string, updateDto: UpdateProfileDto) {
    try {
      const docRef = this.firestore.collection('users').doc(userId);
      const snapshot = await docRef.get();

      if (!snapshot.exists) {
        throw new NotFoundException('Usuario no encontrado en Firestore');
      }

      // 📦 Solo actualizar los campos que se reciban
      const updates: Record<string, unknown> = {};

      if (updateDto.name) updates.name = updateDto.name;
      if (updateDto.lastname) updates.lastname = updateDto.lastname;
      if (updateDto.profileImage) updates.profileImage = updateDto.profileImage;

      // Actualizar enterprise como objeto
      if (updateDto.enterprise) {
        updates.enterprise = updateDto.enterprise;
      }

      if (updateDto.country) updates.country = updateDto.country;
      if (updateDto.marketingConsent !== undefined)
        updates.marketingConsent = updateDto.marketingConsent;
      if (updateDto.accountStatus !== undefined)
        updates.accountStatus = updateDto.accountStatus;

      if (Object.keys(updates).length === 0) {
        throw new BadRequestException('No se enviaron datos para actualizar');
      }

      // ✏️ Actualizar Firestore
      await docRef.update(updates);

      // 🔄 Obtener de nuevo el perfil actualizado
      const updatedSnapshot = await docRef.get();
      const updatedData = updatedSnapshot.data() as UserData;

      return {
        message: 'Perfil actualizado correctamente',
        name: updatedData?.name,
        lastname: updatedData?.lastname,
        profileImage: updatedData?.profileImage,
        enterprise: updatedData?.enterprise || { name: '', url: '' },
        email: updatedData?.email,
        country: updatedData?.country,
        marketingConsent: updatedData?.marketingConsent,
        accountStatus: updatedData?.accountStatus,
        createdAt: updatedData?.createdAt,
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new BadRequestException(
        `Error al actualizar el perfil del usuario: ${(error as Error).message}`,
      );
    }
  }

  // ✅ Subir imagen de perfil
  async uploadProfileImage(userId: string, file: UploadFile) {
    try {
      // Validaciones
      if (!file) {
        throw new BadRequestException('Debe enviarse un archivo de imagen');
      }

      if (file.size > 5 * 1024 * 1024) {
        throw new BadRequestException('La imagen no puede superar los 5MB');
      }

      const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg'];
      if (!allowedTypes.includes(file.mimetype)) {
        throw new BadRequestException(
          'Formato de imagen no permitido. Use PNG o JPG',
        );
      }

      const bucket = this.storage.bucket(process.env.FIREBASE_STORAGE_BUCKET);
      const extension = file.originalname.split('.').pop();
      const fileName = `profile-images/${userId}.${extension}`;
      const fileRef = bucket.file(fileName);

      // Eliminar imagen anterior si existe
      try {
        await fileRef.delete();
      } catch {
        // Ignorar si no existe
      }

      // Subir nueva imagen
      await fileRef.save(file.buffer, {
        metadata: {
          contentType: file.mimetype,
        },
        public: true,
      });

      // Hacer público el archivo
      await fileRef.makePublic();

      const imageUrl = `https://storage.googleapis.com/${process.env.FIREBASE_STORAGE_BUCKET}/${fileName}`;

      // Actualizar URL en Firestore
      const userDocRef = this.firestore.collection('users').doc(userId);
      await userDocRef.update({ profileImage: imageUrl });

      return {
        message: 'Imagen de perfil actualizada correctamente',
        imageUrl,
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(
        `Error al subir la imagen: ${(error as Error).message}`,
      );
    }
  }

  // ✅ Programar eliminación de cuenta (10 días después)
  async scheduleAccountDeletion(userId: string) {
    try {
      const docRef = this.firestore.collection('users').doc(userId);
      const snapshot = await docRef.get();

      if (!snapshot.exists) {
        throw new NotFoundException('Usuario no encontrado en Firestore');
      }

      // Calcular fecha de eliminación (10 días desde ahora)
      const deletionDate = new Date();
      deletionDate.setDate(deletionDate.getDate() + 10);
      const scheduledDeletionTimestamp =
        admin.firestore.Timestamp.fromDate(deletionDate);

      // Guardar la fecha de eliminación programada
      await docRef.update({
        scheduledDeletionDate: scheduledDeletionTimestamp,
      });

      return {
        message: 'Cuenta programada para eliminación en 10 días',
        scheduledDeletionDate: deletionDate.toISOString(),
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new BadRequestException(
        `Error al programar la eliminación de la cuenta: ${(error as Error).message}`,
      );
    }
  }

  // ✅ Procesar eliminaciones programadas (marcar como "Eliminado" después de 10 días)
  async processScheduledDeletions() {
    try {
      const now = admin.firestore.Timestamp.now();

      // Buscar usuarios con scheduledDeletionDate <= ahora
      const usersRef = this.firestore.collection('users');
      const snapshot = await usersRef
        .where('scheduledDeletionDate', '<=', now)
        .get();

      let deletedCount = 0;
      const batches: admin.firestore.WriteBatch[] = [];
      let currentBatch = this.firestore.batch();
      let currentBatchSize = 0;
      const batchSize = 500; // Firestore limita a 500 operaciones por batch

      snapshot.forEach((doc) => {
        const userData = doc.data() as UserData;

        // Solo procesar si accountStatus no es "Eliminado" (2)
        if (userData.accountStatus !== 2) {
          currentBatch.update(doc.ref, {
            accountStatus: 2, // 2 = "Eliminado"
          });
          deletedCount++;
          currentBatchSize++;

          // Si llegamos al límite del batch, guardarlo y crear uno nuevo
          if (currentBatchSize >= batchSize) {
            batches.push(currentBatch);
            currentBatch = this.firestore.batch();
            currentBatchSize = 0;
          }
        }
      });

      // Agregar el batch final si tiene operaciones
      if (currentBatchSize > 0) {
        batches.push(currentBatch);
      }

      // Ejecutar todos los batches
      for (const batch of batches) {
        await batch.commit();
      }

      if (deletedCount > 0) {
        console.log(
          `✅ [Users] ${deletedCount} cuenta(s) marcada(s) como eliminada(s)`,
        );
      }

      return {
        message: `Procesadas ${deletedCount} eliminaciones`,
        deletedCount,
      };
    } catch (error) {
      console.error(
        '❌ [Users] Error al procesar eliminaciones programadas:',
        error,
      );
      throw new BadRequestException(
        `Error al procesar eliminaciones programadas: ${(error as Error).message}`,
      );
    }
  }
}
