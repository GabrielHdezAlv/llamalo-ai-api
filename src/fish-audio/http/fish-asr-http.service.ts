import { Injectable } from '@nestjs/common';
import axios from 'axios';
import FormData from 'form-data';

@Injectable()
export class FishAsrHttpService {
  private fishApiKey = process.env.FISH_API_KEY;
  private language = process.env.FISH_LANG || 'es-ES';

  async transcribeAudio(audioBuffer: Buffer): Promise<string> {
    try {
      console.log('🎙️ Transcribiendo audio ASR HTTP...');
      console.log('📊 Tamaño del buffer:', audioBuffer.length, 'bytes');

      // Verificar que tengamos suficiente audio
      const minAudioSize = 16000; // 1 segundo a 8kHz 16-bit mono
      if (audioBuffer.length < minAudioSize) {
        console.log(
          `⏳ Audio demasiado corto (${audioBuffer.length} bytes), esperando más...`,
        );
        return '';
      }

      const formData = new FormData();

      // Enviar como PCM raw directamente desde el Buffer
      formData.append('audio', audioBuffer, {
        filename: 'audio.pcm',
        contentType: 'audio/pcm',
      });
      formData.append('language', this.language);
      formData.append('sample_rate', '8000'); // 8kHz como Twilio

      console.log('📤 Enviando audio a Fish Audio ASR...');

      const response = await axios.post(
        'https://api.fish.audio/v1/asr',
        formData,
        {
          headers: {
            Authorization: `Bearer ${this.fishApiKey}`,
            ...formData.getHeaders(), // Incluir headers de FormData (boundary, etc.)
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
        console.error('📋 Status Text:', error.response?.statusText);
        console.error(
          '📋 Response Data:',
          JSON.stringify(error.response?.data, null, 2),
        );
        console.error('📋 Request URL:', error.config?.url);
        console.error('📋 Request Method:', error.config?.method);

        // Log del contenido del FormData para debugging
        if (error.config?.data instanceof FormData) {
          console.error('📋 FormData fields:', {
            audioSize: audioBuffer.length,
            language: this.language,
            sample_rate: '8000',
          });
        }
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
