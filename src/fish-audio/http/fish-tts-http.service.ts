import { Injectable } from '@nestjs/common';
import axios from 'axios';
import * as admin from 'firebase-admin';

@Injectable()
export class FishTtsHttpService {
  private fishApiKey = process.env.FISH_API_KEY;
  private voiceId =
    process.env.FISH_TTS_VOICE_ID || 'bfed5c0810a347dbb62e8ccce7f59c48';
  private language = process.env.FISH_LANG || 'es-ES';

  async generateAudio(text: string): Promise<Buffer> {
    try {
      console.log(
        '🎤 Generando audio TTS HTTP:',
        text.substring(0, 50) + '...',
      );

      const response = await axios.post(
        'https://api.fish.audio/v1/tts',
        {
          text,
          format: 'mp3',
          voice_id: this.voiceId,
          language: this.language,
        },
        {
          headers: {
            Authorization: `Bearer ${this.fishApiKey}`,
            'Content-Type': 'application/json',
          },
          responseType: 'arraybuffer',
        },
      );

      console.log('✅ Audio TTS generado exitosamente');
      return Buffer.from(response.data as ArrayBuffer);
    } catch (error) {
      console.error('❌ Error generando audio TTS:', error);
      throw error;
    }
  }

  async generateAudioAndUpload(text: string, userId: string): Promise<string> {
    try {
      const audioBuffer = await this.generateAudio(text);

      // Subir a Firebase Storage
      const audioUrl = await this.uploadToStorage(audioBuffer, userId);

      return audioUrl;
    } catch (error) {
      console.error('❌ Error generando y subiendo audio:', error);
      throw error;
    }
  }

  private async uploadToStorage(
    audioBuffer: Buffer,
    userId: string,
  ): Promise<string> {
    try {
      const bucket = admin
        .storage()
        .bucket(process.env.FIREBASE_STORAGE_BUCKET);

      const audioId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const objectName = `audios/${userId}/${audioId}.mp3`;
      const fileRef = bucket.file(objectName);

      await fileRef.save(audioBuffer, {
        metadata: {
          contentType: 'audio/mpeg',
        },
        public: true,
      });

      await fileRef.makePublic();

      const publicUrl = `https://storage.googleapis.com/${process.env.FIREBASE_STORAGE_BUCKET}/${objectName}`;
      console.log('✅ Audio subido a Storage:', publicUrl);

      return publicUrl;
    } catch (error) {
      console.error('❌ Error subiendo audio a Storage:', error);
      throw error;
    }
  }
}
