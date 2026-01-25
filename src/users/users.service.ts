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
  createdAt?: admin.firestore.Timestamp | string;
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
  enterprise?: string;
  enterpriseWeb?: string;
  email?: string;
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

      // Formatear enterprise para compatibilidad con DTO antiguo
      const enterpriseName = userData?.enterprise?.name || '';
      const enterpriseUrl = userData?.enterprise?.url || '';

      return {
        userId,
        name: userData?.name,
        lastname: userData?.lastname,
        profileImage: userData?.profileImage,
        enterprise: enterpriseName, // Compatibilidad con DTO antiguo
        enterpriseWeb: enterpriseUrl, // Compatibilidad con DTO antiguo
        email: userData?.email,
        createdAt: createdAtStr,
        twilio: userData?.twilio,
        agent: userData?.agents?.[0] || {}, // Compatibilidad: devolver primer agente como agent
        // Nuevos campos
        integrations: userData?.integrations,
        phoneNumbers: userData?.phoneNumbers || [],
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
      if (updateDto.enterprise || updateDto.enterpriseWeb) {
        const currentData = snapshot.data() as UserData;
        const currentEnterprise = currentData?.enterprise || { name: '', url: '' };
        updates.enterprise = {
          name: updateDto.enterprise || currentEnterprise.name,
          url: updateDto.enterpriseWeb || currentEnterprise.url,
        };
      }

      if (Object.keys(updates).length === 0) {
        throw new BadRequestException('No se enviaron datos para actualizar');
      }

      // ✏️ Actualizar Firestore
      await docRef.update(updates);

      // 🔄 Obtener de nuevo el perfil actualizado
      const updatedSnapshot = await docRef.get();
      const updatedData = updatedSnapshot.data() as UserData;

      // Formatear enterprise para compatibilidad con DTO antiguo
      const enterpriseName = updatedData?.enterprise?.name || '';
      const enterpriseUrl = updatedData?.enterprise?.url || '';

      return {
        message: 'Perfil actualizado correctamente',
        name: updatedData?.name,
        lastname: updatedData?.lastname,
        profileImage: updatedData?.profileImage,
        enterprise: enterpriseName, // Compatibilidad con DTO antiguo
        enterpriseWeb: enterpriseUrl, // Compatibilidad con DTO antiguo
        email: updatedData?.email,
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
}
