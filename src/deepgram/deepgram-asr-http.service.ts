import { Injectable } from '@nestjs/common';
import { spawn } from 'child_process';
import * as ffmpeg from '@ffmpeg-installer/ffmpeg';
import { promises as fs } from 'fs';
import * as path from 'path';
import { createClient, DeepgramClient } from '@deepgram/sdk';

const ffmpegPath = (ffmpeg as { path: string }).path;

@Injectable()
export class DeepgramAsrHttpService {
  private readonly deepgram: DeepgramClient | null;
  private readonly language = process.env.DG_LANGUAGE || 'es';
  private readonly model = process.env.DG_MODEL || 'nova-2';
  private readonly tier = process.env.DG_TIER;
  private readonly smartFormat = parseBoolean(
    process.env.DG_SMART_FORMAT,
    true,
  );
  private readonly punctuate = parseBoolean(process.env.DG_PUNCTUATE, true);
  private readonly diarize = parseBoolean(process.env.DG_DIARIZE, false);
  private readonly sampleRate = Number.parseInt(
    process.env.DG_SAMPLE_RATE ?? '16000',
    10,
  );
  private readonly debugSaveWav =
    process.env.DG_DEBUG_SAVE_WAV === 'true' ||
    process.env.DG_DEBUG_SAVE_WAV === '1';
  private readonly debugWavDir =
    process.env.DG_DEBUG_WAV_DIR || '/tmp/deepgram-wavs';

  constructor() {
    const apiKey = process.env.DG_API_KEY;
    if (!apiKey) {
      console.error(
        '❌ DG_API_KEY no configurado. Deepgram ASR HTTP no funcionará.',
      );
      this.deepgram = null;
      return;
    }
    this.deepgram = createClient(apiKey);
  }

  async transcribeAudio(audioBuffer: Buffer): Promise<string> {
    if (!this.deepgram) {
      console.error('❌ Deepgram client no inicializado.');
      return '';
    }

    try {
      console.log('🎙️ Transcribiendo audio con Deepgram...');
      console.log('📊 Tamaño del buffer PCM:', audioBuffer.length, 'bytes');

      const minAudioSize = 16000; // 1 segundo a 8kHz 16-bit mono
      if (audioBuffer.length < minAudioSize) {
        console.log(
          `⏳ Audio demasiado corto (${audioBuffer.length} bytes), esperando más...`,
        );
        return '';
      }

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

      console.log(`🔄 Resampling de 8kHz a 16kHz con ffmpeg...`);
      const pcm16khz = await this.resampleTo16k(audioBuffer);
      console.log(
        `✅ Audio resampled: ${audioBuffer.length} bytes (8kHz) → ${pcm16khz.length} bytes (16kHz)`,
      );

      const wavBuffer = this.pcmToWav(pcm16khz, this.sampleRate);
      console.log(
        `🔄 WAV generado: ${wavBuffer.length} bytes (header + datos, 16kHz)`,
      );

      await this.saveDebugWav(wavBuffer);

      const options: Record<string, unknown> = {
        mimetype: 'audio/wav',
        model: this.model,
        language: this.language,
        smart_format: this.smartFormat,
        punctuate: this.punctuate,
        diarize: this.diarize,
        encoding: 'linear16',
        sample_rate: this.sampleRate,
      };
      if (this.tier) {
        options.tier = this.tier;
      }

      const start = Date.now();
      const response = await this.deepgram.listen.prerecorded.transcribeFile(
        wavBuffer,
        options,
      );
      const elapsed = Date.now() - start;

      const transcript =
        response.result?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ||
        '';
      console.log(
        `✅ Deepgram transcript (${elapsed}ms):`,
        transcript || '[vacío]',
      );
      return transcript;
    } catch (error) {
      console.error('❌ Error transcribiendo con Deepgram:', error);
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
      const fileName = `deepgram-asr-${Date.now()}.wav`;
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

function parseBoolean(
  value: string | undefined,
  defaultValue = false,
): boolean {
  if (value === undefined) return defaultValue;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return defaultValue;
}
