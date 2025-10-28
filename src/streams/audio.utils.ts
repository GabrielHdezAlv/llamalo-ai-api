import { encode, decode } from 'mulaw-js';

export function ulawToPcm16(b64: string): Int16Array {
  try {
    // Validar entrada
    if (!b64 || typeof b64 !== 'string') {
      throw new Error('Payload base64 inválido: debe ser una cadena');
    }

    // Decodificar base64
    const bytes = Buffer.from(b64, 'base64');

    // Validar que se haya decodificado correctamente
    if (bytes.length === 0) {
      throw new Error('Payload base64 vacío después de decodificar');
    }

    // Convertir μ-law a PCM16
    const pcm = (decode as (data: Uint8Array) => Int16Array)(bytes);

    // Validar resultado
    if (!pcm || pcm.length === 0) {
      throw new Error('Error en la conversión μ-law a PCM16: resultado vacío');
    }

    return pcm;
  } catch (error) {
    console.error('Error en ulawToPcm16:', error);
    throw error;
  }
}

export function pcm16ToUlawB64(pcm: Int16Array): string {
  const ulaw = (encode as (data: Int16Array) => Uint8Array)(pcm);
  return Buffer.from(ulaw).toString('base64');
}
