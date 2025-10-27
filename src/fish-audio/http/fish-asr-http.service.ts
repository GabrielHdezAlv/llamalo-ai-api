import { Injectable } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class FishAsrHttpService {
  private fishApiKey = process.env.FISH_API_KEY;
  private language = process.env.FISH_LANG || 'es-ES';

  async transcribeAudio(audioBuffer: Buffer): Promise<string> {
    try {
      console.log('🎙️ Transcribiendo audio ASR HTTP...');
      console.log('📊 Tamaño del buffer:', audioBuffer.length, 'bytes');

      const formData = new FormData();

      // Enviar como PCM raw en lugar de WAV
      formData.append(
        'audio',
        new Blob([audioBuffer.buffer as ArrayBuffer], { type: 'audio/pcm' }),
        'audio.pcm',
      );
      formData.append('language', this.language);
      formData.append('sample_rate', '8000'); // 8kHz como Twilio

      console.log('📤 Enviando audio a Fish Audio ASR...');

      const response = await axios.post(
        'https://api.fish.audio/v1/asr',
        formData,
        {
          headers: {
            Authorization: `Bearer ${this.fishApiKey}`,
            // No especificar Content-Type, axios lo manejará automáticamente para FormData
          },
        },
      );

      const transcript = response.data?.text || '';
      console.log('✅ Audio transcrito:', transcript);

      return transcript;
    } catch (error) {
      console.error('❌ Error transcribiendo audio ASR:', error);
      if (axios.isAxiosError(error)) {
        console.error('📋 Status:', error.response?.status);
        console.error('📋 Data:', error.response?.data);
        console.error('📋 Headers:', error.response?.headers);
      }
      throw error;
    }
  }

  async transcribeFromBase64(audioBase64: string): Promise<string> {
    try {
      const audioBuffer = Buffer.from(audioBase64, 'base64');
      return await this.transcribeAudio(audioBuffer);
    } catch (error) {
      console.error('❌ Error transcribiendo desde base64:', error);
      throw error;
    }
  }
}
