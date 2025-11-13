import { Injectable } from '@nestjs/common';
import axios from 'axios';
import FormData from 'form-data';

@Injectable()
export class FishAsrHttpService {
  private fishApiKey = process.env.FISH_API_KEY;
  private language = process.env.FISH_LANG || 'es-ES';
  private sampleRate = Number.parseInt(
    process.env.FISH_ASR_SAMPLE_RATE ?? '8000',
    10,
  );
  private model = process.env.FISH_ASR_MODEL;
  private latency = process.env.FISH_ASR_LATENCY_MODE;
  private enablePunctuation = parseBoolean(
    process.env.FISH_ASR_ENABLE_PUNCTUATION,
  );
  private enableTimestamps = parseBoolean(
    process.env.FISH_ASR_ENABLE_WORD_TIMESTAMPS,
  );
  private readonly extraFormFields = parseJsonEnv(
    process.env.FISH_ASR_HTTP_OPTIONS_JSON,
  );

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
      formData.append('sample_rate', this.sampleRate);
      if (this.model) {
        formData.append('model', this.model);
      }
      if (this.latency) {
        formData.append('latency', this.latency);
      }
      if (this.enablePunctuation !== undefined) {
        formData.append(
          'enable_punctuation',
          this.enablePunctuation ? 'true' : 'false',
        );
      }
      if (this.enableTimestamps !== undefined) {
        formData.append(
          'enable_word_timestamps',
          this.enableTimestamps ? 'true' : 'false',
        );
      }
      for (const [key, value] of Object.entries(this.extraFormFields)) {
        if (value !== undefined && value !== null) {
          const normalized =
            typeof value === 'string' ? value : JSON.stringify(value);
          formData.append(key, normalized);
        }
      }

      console.log('📤 Enviando audio a Fish Audio ASR...');
      console.log(
        `📋 Parámetros: language=${this.language}, sample_rate=${this.sampleRate}, model=${this.model ?? 'default'}, latency=${this.latency ?? 'default'}, filename=audio.wav`,
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
            sample_rate: this.sampleRate,
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
    const sampleRate = this.sampleRate;
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

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
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
      'No se pudo parsear FISH_ASR_HTTP_OPTIONS_JSON:',
      error instanceof Error ? error.message : String(error),
    );
  }
  return {};
}
