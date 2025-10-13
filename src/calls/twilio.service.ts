import { Injectable } from '@nestjs/common';
import { twiml as TwiML } from 'twilio';

@Injectable()
export class TwilioService {
  newVoiceResponse(): TwiML.VoiceResponse {
    return new TwiML.VoiceResponse();
  }
}
