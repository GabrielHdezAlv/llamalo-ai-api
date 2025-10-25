import { Injectable } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class TwilioCallMediaService {
  private accountSid = process.env.TWILIO_ACCOUNT_SID!;
  private authToken = process.env.TWILIO_AUTH_TOKEN!;

  /**
   * Reproduce un audio (MP3 o WAV) en una llamada activa usando la Twilio Call Media API.
   * Docs: https://www.twilio.com/docs/voice/api/call-resource#play-call
   */
  async playUrl(callSid: string, audioUrl: string): Promise<void> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Calls/${callSid}/Play.json`;

    try {
      const response = await axios.post(
        url,
        new URLSearchParams({ AudioUrl: audioUrl }).toString(),
        {
          auth: {
            username: this.accountSid,
            password: this.authToken,
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
