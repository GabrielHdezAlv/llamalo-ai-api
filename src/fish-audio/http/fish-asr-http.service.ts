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

      // Verificar que el audio no sea silencio
      const audioLevel = this.calculateAudioLevel(audioBuffer);
      console.log(
        `📊 Nivel de audio: ${audioLevel.toFixed(2)} (umbral mínimo: 100)`,
      );

      if (audioLevel < 100) {
        console.log(
          '🔇 Audio es silencio o muy bajo, omitiendo transcripción...',
        );
        return '';
      }

      // TEMPORAL: Intentar sin resampleo para diagnosticar
      console.log(
        `⚠️ MODO DEBUG: Enviando audio a 8kHz sin resampleo para testing`,
      );

      // Convertir PCM a WAV con sample rate ORIGINAL de 8kHz
      const wavBuffer = this.pcmToWav(audioBuffer, 8000);
      console.log(
        `🔄 WAV generado: ${wavBuffer.length} bytes (header: 44 bytes, data: ${wavBuffer.length - 44} bytes, 8kHz)`,
      );

      // Simplificar código de idioma (es-ES → es, en-US → en)
      const simpleLanguage = this.language.split('-')[0]; // "es-ES" → "es"

      // Enviar como WAV - SOLO parámetros documentados
      formData.append('audio', wavBuffer, {
        filename: 'audio.wav',
        contentType: 'audio/wav',
      });
      formData.append('language', simpleLanguage);

      // Solo agregar parámetros extras si están explícitamente configurados
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
      // Permitir parámetros extra solo si están en la configuración JSON
      for (const [key, value] of Object.entries(this.extraFormFields)) {
        if (value !== undefined && value !== null) {
          const normalized =
            typeof value === 'string' ? value : JSON.stringify(value);
          formData.append(key, normalized);
        }
      }

      console.log('📤 Enviando audio a Fish Audio ASR...');
      console.log(
        `📋 Parámetros: language=${simpleLanguage}, filename=audio.wav, size=${wavBuffer.length} bytes, sampleRate=8000Hz`,
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
          const simpleLanguage = this.language.split('-')[0];
          const wavSize = audioBuffer.length + 44; // PCM + header WAV
          console.error('📋 FormData fields:', {
            audioSize8kHz: audioBuffer.length,
            wavSize: wavSize,
            language: simpleLanguage,
            sampleRate: '8000Hz',
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
   * Calcula el nivel RMS (Root Mean Square) del audio para detectar silencio
   * @param pcmBuffer Buffer con datos PCM16
   * @returns Nivel RMS del audio
   */
  private calculateAudioLevel(pcmBuffer: Buffer): number {
    let sum = 0;
    const sampleCount = pcmBuffer.length / 2; // 16-bit = 2 bytes por muestra

    for (let i = 0; i < pcmBuffer.length; i += 2) {
      const sample = pcmBuffer.readInt16LE(i);
      sum += sample * sample;
    }

    const rms = Math.sqrt(sum / sampleCount);
    return rms;
  }

  /**
   * Resamplea audio de 8kHz a 16kHz usando interpolación lineal
   * Fish Audio ASR requiere 16kHz o superior según su documentación
   * @param pcm8khz Buffer con datos PCM16 a 8kHz
   * @returns Buffer con datos PCM16 a 16kHz
   */
  private resample8kTo16k(pcm8khz: Buffer): Buffer {
    // Convertir buffer a array de samples de 16-bit
    const samples8k: number[] = [];
    for (let i = 0; i < pcm8khz.length; i += 2) {
      samples8k.push(pcm8khz.readInt16LE(i));
    }

    // Interpolación lineal para duplicar el sample rate
    const samples16k: number[] = [];
    for (let i = 0; i < samples8k.length - 1; i++) {
      const current = samples8k[i];
      const next = samples8k[i + 1];

      // Muestra original
      samples16k.push(current);

      // Muestra interpolada (promedio entre current y next)
      const interpolated = Math.round((current + next) / 2);
      samples16k.push(interpolated);
    }

    // Agregar la última muestra
    if (samples8k.length > 0) {
      samples16k.push(samples8k[samples8k.length - 1]);
      samples16k.push(samples8k[samples8k.length - 1]); // Duplicar última muestra
    }

    // Convertir de vuelta a Buffer
    const buffer16k = Buffer.alloc(samples16k.length * 2);
    for (let i = 0; i < samples16k.length; i++) {
      buffer16k.writeInt16LE(samples16k[i], i * 2);
    }

    return buffer16k;
  }

  /**
   * Convierte un Buffer PCM16 a formato WAV
   * @param pcmBuffer Buffer con datos PCM16 (16-bit signed integers, little-endian)
   * @param sampleRateOverride Sample rate a usar (por defecto usa this.sampleRate)
   * @returns Buffer con formato WAV
   */
  private pcmToWav(pcmBuffer: Buffer, sampleRateOverride?: number): Buffer {
    const sampleRate = sampleRateOverride || this.sampleRate;
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
