import { encode, decode } from 'mulaw-js';

export function ulawToPcm16(b64: string): Int16Array {
  const bytes = Buffer.from(b64, 'base64');
  return (decode as (data: Uint8Array) => Int16Array)(bytes);
}

export function pcm16ToUlawB64(pcm: Int16Array): string {
  const ulaw = (encode as (data: Int16Array) => Uint8Array)(pcm);
  return Buffer.from(ulaw).toString('base64');
}
