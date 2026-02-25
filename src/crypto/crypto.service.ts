import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class CryptoService {
  private readonly algorithm = 'aes-256-gcm';
  private readonly ivLength = 12; // GCM standard

  /**
   * Genera una clave segura de 32 bytes basándose en el secreto de entorno.
   */
  private getKey(): Buffer {
    const secret = process.env.ENCRYPTION_KEY;

    if (!secret) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          'CRITICAL: ENCRYPTION_KEY no está configurada en el entorno de producción. ¡Cifrado fallido!',
        );
      }
      console.warn(
        '⚠️ WARNING: Usando clave de cifrado por defecto en desarrollo. Configura ENCRYPTION_KEY.',
      );
    }

    const finalSecret = secret || 'llamalo-ai-default-encryption-key-for-dev';
    return crypto.createHash('sha256').update(String(finalSecret)).digest();
  }

  /**
   * Cifra un texto usando aes-256-gcm.
   * Retorna una cadena con el formato iv:authTag:encryptedText.
   */
  encrypt(text: string): string {
    if (!text) return text;

    try {
      const key = this.getKey();
      const iv = crypto.randomBytes(this.ivLength);
      const cipher = crypto.createCipheriv(this.algorithm, key, iv);

      const encrypted = Buffer.concat([
        cipher.update(text, 'utf8'),
        cipher.final(),
      ]);

      const authTag = cipher.getAuthTag();

      // Devolvemos todo codificado en hex y separado por :
      return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
    } catch {
      // Evitamos imprimir el objeto error o datos sensibles en logs
      console.error('Error interno al cifrar datos.');
      throw new Error('Cifrado fallido');
    }
  }

  /**
   * Descifra un texto previamente cifrado con encrypt().
   * Si el texto no tiene el formato esperado (ej. migraciones de datos no cifrados), lo retorna tal cual en desarrollo.
   * En producción requiere formato válido y descifrado exitoso.
   */
  decrypt(encryptedData: string): string {
    if (!encryptedData) return encryptedData;

    const parts = encryptedData.split(':');

    if (parts.length !== 3) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          'CRITICAL: Intento de usar token no cifrado o con formato inválido en entorno de producción. Migra tus tokens o verifica ENCRYPTION_KEY.',
        );
      }
      console.warn(
        '⚠️ WARNING: Usando token no cifrado en desarrollo. Migra tus tokens.',
      );
      return encryptedData; // Fallback (solo dev)
    }

    try {
      const iv = Buffer.from(parts[0], 'hex');
      const authTag = Buffer.from(parts[1], 'hex');
      const encryptedText = Buffer.from(parts[2], 'hex');
      const key = this.getKey();

      const decipher = crypto.createDecipheriv(this.algorithm, key, iv);
      decipher.setAuthTag(authTag);

      const decrypted = Buffer.concat([
        decipher.update(encryptedText),
        decipher.final(),
      ]);

      return decrypted.toString('utf8');
    } catch {
      // Error típico aquí: 'Unsupported state or unable to authenticate data' (AuthTag inválido)
      console.error(
        'CRITICAL: Fallo de autenticación al descifrar datos (AuthTag inválido o clave incorrecta).',
      );

      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          'Fallo al descifrar token en producción. Verifica ENCRYPTION_KEY.',
        );
      }

      return encryptedData; // Fallback (solo dev)
    }
  }
}
