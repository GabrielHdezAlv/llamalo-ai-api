import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import * as admin from 'firebase-admin';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { getFirestore } from '../firebase/firebase.config';

interface UserData {
  name?: string;
  lastname?: string;
  profileImage?: string;
  enterprise?: string;
  enterpriseWeb?: string;
  email?: string;
  createdAt?: string;
  twilio?: Record<string, unknown>;
  agent?: Record<string, unknown>;
}

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
  async getUserProfile(userId: string) {
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
        enterprise: userData?.enterprise,
        enterpriseWeb: userData?.enterpriseWeb,
        email: userData?.email,
        createdAt: createdAtStr,
        twilio: userData?.twilio,
        agent: userData?.agent,
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
      const updates: Record<string, string> = {};

      if (updateDto.name) updates.name = updateDto.name;
      if (updateDto.lastname) updates.lastname = updateDto.lastname;
      if (updateDto.profileImage) updates.profileImage = updateDto.profileImage;
      if (updateDto.enterprise) updates.enterprise = updateDto.enterprise;
      if (updateDto.enterpriseWeb)
        updates.enterpriseWeb = updateDto.enterpriseWeb;

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
        enterprise: updatedData?.enterprise,
        enterpriseWeb: updatedData?.enterpriseWeb,
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
