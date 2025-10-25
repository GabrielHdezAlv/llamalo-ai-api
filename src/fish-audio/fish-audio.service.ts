import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import * as admin from 'firebase-admin';
import axios from 'axios';
import { getFirestore } from '../firebase/firebase.config';

@Injectable()
export class FishAudioService {
  private firestore = getFirestore();
  private storage = admin.storage();
  private fishApiKey = process.env.FISH_API_KEY;

  async setFirstInteraction(userId: string, firstInteraction: string) {
    try {
      // Obtener la referencia al documento del usuario
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (!userSnapshot.exists) {
        throw new NotFoundException('Usuario no encontrado.');
      }

      const userData = userSnapshot.data() as Record<string, unknown>;
      const twilioConfig = (userData?.twilio as Record<string, unknown>) || {};

      // Verificar si el texto ya fue usado anteriormente
      if (twilioConfig.firstInteraction === firstInteraction) {
        return {
          message:
            'Ya se ha generado un audio con este mismo texto. Por favor, modifica el mensaje antes de generar uno nuevo.',
        };
      }

      // Generar audio con Fish.audio API
      const audioBuffer = await this.generateAudioWithFish(firstInteraction);

      // Subir el audio a Firebase Storage
      const audioUrl = await this.uploadAudioToStorage(userId, audioBuffer);

      // Actualizar Firestore con la nueva URL y texto
      twilioConfig.firstInteractionUrl = audioUrl;
      twilioConfig.firstInteraction = firstInteraction;

      await userDocRef.set({ twilio: twilioConfig }, { merge: true });

      return {
        message: 'Audio generado y URL guardada exitosamente.',
        audioUrl,
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new BadRequestException(
        `Error al procesar la configuración: ${(error as Error).message}`,
      );
    }
  }

  private async generateAudioWithFish(text: string): Promise<Buffer> {
    try {
      const response = await axios.post(
        'https://api.fish.audio/v1/tts',
        {
          text,
          format: 'mp3',
        },
        {
          headers: {
            Authorization: `Bearer ${this.fishApiKey}`,
            'Content-Type': 'application/json',
            model: 's1',
          },
          responseType: 'arraybuffer',
        },
      );

      return Buffer.from(response.data as ArrayBuffer);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const errorData = error.response?.data
          ? Buffer.from(error.response.data as ArrayBuffer).toString()
          : error.message;
        throw new BadRequestException(`Error de Fish.audio API: ${errorData}`);
      }
      throw new BadRequestException(
        `Error al generar audio: ${(error as Error).message}`,
      );
    }
  }

  private async uploadAudioToStorage(
    userId: string,
    audioBuffer: Buffer,
  ): Promise<string> {
    try {
      const bucket = this.storage.bucket(process.env.FIREBASE_STORAGE_BUCKET);
      const audioId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const objectName = `audios/${userId}/${audioId}.mp3`;
      const fileRef = bucket.file(objectName);

      // Subir el archivo
      await fileRef.save(audioBuffer, {
        metadata: {
          contentType: 'audio/mpeg',
        },
        public: true,
      });

      // Hacer público el archivo
      await fileRef.makePublic();

      const publicUrl = `https://storage.googleapis.com/${process.env.FIREBASE_STORAGE_BUCKET}/${objectName}`;

      return publicUrl;
    } catch (error) {
      throw new BadRequestException(
        `Error al subir audio a Storage: ${(error as Error).message}`,
      );
    }
  }
}
