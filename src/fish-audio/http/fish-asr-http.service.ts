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
      console.log('📊 Tamaño del buffer PCM:', audioBuffer.length, 'bytes');
      console.log('📊 Tamaño estimado WAV:', audioBuffer.length + 44, 'bytes');

      // Verificar que tengamos suficiente audio
      const minAudioSize = 16000; // 1 segundo a 8kHz 16-bit mono
      if (audioBuffer.length < minAudioSize) {
        console.log(
          `⏳ Audio demasiado corto (${audioBuffer.length} bytes), esperando más...`,
        );
        return '';
      }

      const formData = new FormData();

      // Convertir PCM a WAV (formato más compatible)
      const wavBuffer = this.pcmToWav(audioBuffer);
      console.log(
        `🔄 WAV generado: ${wavBuffer.length} bytes (header: 44 bytes, data: ${wavBuffer.length - 44} bytes)`,
      );

      // Enviar como WAV
      formData.append('audio', wavBuffer, {
        filename: 'audio.wav',
        contentType: 'audio/wav',
      });
      formData.append('language', this.language);
      formData.append('sample_rate', 8000); // 8kHz como Twilio (número, no string)

      console.log('📤 Enviando audio a Fish Audio ASR...');
      console.log(
        `📋 Parámetros: language=${this.language}, sample_rate=8000, filename=audio.wav`,
      );

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
            wavSize: audioBuffer.length + 44,
            language: this.language,
            sample_rate: 8000,
            contentType: 'audio/wav',
            filename: 'audio.wav',
          });
        }

        // Log adicional de la respuesta del servidor
        if (error.response?.data) {
          console.error('📋 Fish Audio API Response:', error.response.data);
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

  /**
   * Convierte un Buffer PCM16 a formato WAV
   * @param pcmBuffer Buffer con datos PCM16 (16-bit signed integers, little-endian)
   * @returns Buffer con formato WAV
   */
  private pcmToWav(pcmBuffer: Buffer): Buffer {
    const sampleRate = 8000;
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const dataSize = pcmBuffer.length;
    const fileSize = 36 + dataSize;

    const buffer = Buffer.alloc(44 + dataSize);

    // WAV header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(fileSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20); // PCM format
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    // PCM data (ya está en el formato correcto)
    pcmBuffer.copy(buffer, 44);

    return buffer;
  }
}
