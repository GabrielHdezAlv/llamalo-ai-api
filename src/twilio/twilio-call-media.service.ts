import { Injectable } from '@nestjs/common';
import axios from 'axios';

interface TwilioCredentials {
  accountSid: string;
  authToken: string;
}

@Injectable()
export class TwilioCallMediaService {
  private readonly defaultAccountSid = process.env.TWILIO_ACCOUNT_SID;
  private readonly defaultAuthToken = process.env.TWILIO_AUTH_TOKEN;
  private readonly callCredentials = new Map<string, TwilioCredentials>();

  registerCallCredentials(
    callSid: string | undefined,
    accountSid?: string,
    authToken?: string,
  ) {
    if (!callSid) {
      return;
    }
    if (accountSid && authToken) {
      this.callCredentials.set(callSid, { accountSid, authToken });
      console.log(`🔐 Credenciales Twilio registradas para ${callSid}`);
    } else {
      console.warn(
        `⚠️ Credenciales incompletas para ${callSid}, se usarán las variables de entorno`,
      );
    }
  }

  clearCallCredentials(callSid: string | undefined) {
    if (callSid && this.callCredentials.delete(callSid)) {
      console.log(`🧹 Credenciales Twilio eliminadas para ${callSid}`);
    }
  }

  /**
   * Reproduce un audio (MP3 o WAV) en una llamada activa usando la Twilio Call Media API.
   * Docs: https://www.twilio.com/docs/voice/api/call-resource#play-call
   */
  async playUrl(callSid: string, audioUrl: string): Promise<void> {
    const creds =
      this.callCredentials.get(callSid) ||
      (this.defaultAccountSid && this.defaultAuthToken
        ? {
            accountSid: this.defaultAccountSid,
            authToken: this.defaultAuthToken,
          }
        : null);

    if (!creds) {
      console.error(
        `❌ No hay credenciales Twilio disponibles para la llamada ${callSid}`,
      );
      return;
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Calls/${callSid}/Play.json`;

    try {
      const response = await axios.post(
        url,
        new URLSearchParams({ AudioUrl: audioUrl }).toString(),
        {
          auth: {
            username: creds.accountSid,
            password: creds.authToken,
          },
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      console.log(`🎧 Audio enviado a llamada ${callSid}: ${audioUrl}`);
      console.log('📡 Twilio Play response:', response.data.sid);
    } catch (err: any) {
      console.error(
        '❌ Error al reproducir audio mediante Twilio Call Media API:',
        err.response?.data || err.message,
      );
    }
  }
}
