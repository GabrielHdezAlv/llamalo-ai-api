import { Injectable } from '@nestjs/common';
import axios from 'axios';
import FormData from 'form-data';
import { spawn } from 'child_process';
import * as ffmpeg from '@ffmpeg-installer/ffmpeg';
import { promises as fs } from 'fs';
import * as path from 'path';

const ffmpegPath = (ffmpeg as { path: string }).path;

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
  private readonly debugSaveWav =
    process.env.FISH_DEBUG_SAVE_WAV === 'true' ||
    process.env.FISH_DEBUG_SAVE_WAV === '1';
  private readonly debugWavDir =
    process.env.FISH_DEBUG_WAV_DIR || '/tmp/fish-wavs';

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

      // Resamplear de 8kHz a 16kHz usando ffmpeg para evitar distorsión
      console.log(`🔄 Resampling de 8kHz a 16kHz con ffmpeg...`);
      const pcm16khz = await this.resampleTo16k(audioBuffer);
      console.log(
        `✅ Audio resampled: ${audioBuffer.length} bytes (8kHz) → ${pcm16khz.length} bytes (16kHz)`,
      );

      // Convertir PCM a WAV con sample rate de 16kHz
      const wavBuffer = this.pcmToWav(pcm16khz, 16000);
      console.log(
        `🔄 WAV generado: ${wavBuffer.length} bytes (header: 44 bytes, data: ${wavBuffer.length - 44} bytes, 16kHz)`,
      );

      await this.saveDebugWav(wavBuffer);

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
        `📋 Parámetros: language=${simpleLanguage}, filename=audio.wav, size=${wavBuffer.length} bytes, sampleRate=16000Hz`,
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
          const resampledSize = audioBuffer.length * 2;
          const wavSize = resampledSize + 44;
          console.error('📋 FormData fields:', {
            audioSizeOriginal8kHz: audioBuffer.length,
            audioSizeResampled16kHz: resampledSize,
            wavSize,
            language: simpleLanguage,
            sampleRate: '16000Hz',
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

  private async saveDebugWav(wavBuffer: Buffer): Promise<void> {
    if (!this.debugSaveWav) {
      return;
    }
    try {
      await fs.mkdir(this.debugWavDir, { recursive: true });
      const fileName = `fish-asr-${Date.now()}.wav`;
      const filePath = path.join(this.debugWavDir, fileName);
      await fs.writeFile(filePath, wavBuffer);
      console.log(
        `💾 WAV de debug guardado (${wavBuffer.length} bytes) en: ${filePath}`,
      );
    } catch (error) {
      console.error('⚠️ No se pudo guardar WAV de debug:', error);
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
   * Resamplea audio de 8kHz a 16kHz utilizando ffmpeg para obtener calidad adecuada.
   */
  private async resampleTo16k(pcm8khz: Buffer): Promise<Buffer> {
    const ffmpegArgs = [
      '-loglevel',
      'error',
      '-f',
      's16le',
      '-ar',
      '8000',
      '-ac',
      '1',
      '-i',
      'pipe:0',
      '-f',
      's16le',
      '-ar',
      '16000',
      '-ac',
      '1',
      'pipe:1',
    ];

    return new Promise<Buffer>((resolve, reject) => {
      const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const chunks: Buffer[] = [];

      ffmpegProcess.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      ffmpegProcess.stderr.on('data', (data: Buffer) => {
        console.error('⚠️ ffmpeg stderr:', data.toString());
      });

      ffmpegProcess.on('error', (error) => {
        reject(error);
      });

      ffmpegProcess.on('close', (code) => {
        if (code === 0) {
          resolve(Buffer.concat(chunks));
        } else {
          reject(new Error(`ffmpeg exited with code ${code}`));
        }
      });

      ffmpegProcess.stdin.write(pcm8khz);
      ffmpegProcess.stdin.end();
    });
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
