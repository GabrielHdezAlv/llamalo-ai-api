import { Injectable } from '@nestjs/common';
import axios from 'axios';
import * as admin from 'firebase-admin';

@Injectable()
export class FishTtsHttpService {
  private fishApiKey = process.env.FISH_API_KEY;
  private voiceId =
    process.env.FISH_TTS_VOICE_ID || 'bfed5c0810a347dbb62e8ccce7f59c48';
  private language = process.env.FISH_LANG || 'es-ES';
  private latency = process.env.FISH_TTS_LATENCY_MODE;
  private format = process.env.FISH_TTS_AUDIO_FORMAT || 'mp3';
  private emotion = process.env.FISH_TTS_EMOTION;
  private style = process.env.FISH_TTS_STYLE;
  private textType = process.env.FISH_TTS_TEXT_TYPE as
    | 'plain'
    | 'ssml'
    | undefined;
  private speed = toOptionalNumber(process.env.FISH_TTS_SPEED);
  private pitch = toOptionalNumber(process.env.FISH_TTS_PITCH);
  private volume = toOptionalNumber(process.env.FISH_TTS_VOLUME);
  private model = process.env.FISH_TTS_MODEL;
  private readonly extraPayload = parseJsonEnv(
    process.env.FISH_TTS_HTTP_OPTIONS_JSON,
  );

  async generateAudio(text: string): Promise<Buffer> {
    try {
      console.log(
        '🎤 Generando audio TTS HTTP:',
        text.substring(0, 50) + '...',
      );

      const response = await axios.post(
        'https://api.fish.audio/v1/tts',
        this.buildPayload(text),
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

  private buildPayload(text: string): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      text,
      format: this.format,
      voice_id: this.voiceId,
      language: this.language,
    };
    if (this.latency) payload.latency = this.latency;
    if (this.emotion) payload.emotion = this.emotion;
    if (this.style) payload.style = this.style;
    if (this.textType) payload.text_type = this.textType;
    if (typeof this.speed === 'number') payload.speed = this.speed;
    if (typeof this.pitch === 'number') payload.pitch = this.pitch;
    if (typeof this.volume === 'number') payload.volume = this.volume;
    if (this.model) payload.model = this.model;
    Object.assign(payload, this.extraPayload);
    return payload;
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

function toOptionalNumber(value?: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseJsonEnv(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (error) {
    console.error(
      'No se pudo parsear FISH_TTS_HTTP_OPTIONS_JSON:',
      error instanceof Error ? error.message : String(error),
    );
  }
  return {};
}
