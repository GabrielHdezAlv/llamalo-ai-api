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
  private readonly baseUrl =
    process.env.PUBLIC_BASE_URL?.replace(/\/$/, '') ||
    'https://llamaloiabackend-5294.onrender.com';

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
      const status = err.response?.status;
      const code = err.response?.data?.code;
      console.error(
        '❌ Error al reproducir audio mediante Twilio Call Media API:',
        err.response?.data || err.message,
      );

      // Plan B: si la Call Media API no está habilitada (20404), actualizar TwiML
      if (status === 404 && code === 20404) {
        console.log(
          `🔁 Call Media API no disponible para ${callSid}, usando fallback TwiML...`,
        );
        await this.updateCallWithTwiml(
          creds.accountSid,
          creds.authToken,
          callSid,
          audioUrl,
        );
      }
    }
  }

  private async updateCallWithTwiml(
    accountSid: string,
    authToken: string,
    callSid: string,
    audioUrl: string,
  ): Promise<void> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`;
    const redirectUrl = `${this.baseUrl}/voice/resume?callSid=${encodeURIComponent(
      callSid,
    )}`;
    const twiml = `<Response><Play>${audioUrl}</Play><Redirect method="POST">${redirectUrl}</Redirect></Response>`;

    try {
      const response = await axios.post(
        url,
        new URLSearchParams({ Twiml: twiml }).toString(),
        {
          auth: {
            username: accountSid,
            password: authToken,
          },
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      console.log(
        `🔁 Fallback TwiML aplicado a llamada ${callSid}, estado ${response.data.status}`,
      );
    } catch (error: any) {
      console.error(
        `❌ Error aplicando fallback TwiML a llamada ${callSid}:`,
        error.response?.data || error.message,
      );
    }
  }
}
