import { Controller, Post, Body, Res } from '@nestjs/common';
import type { Response } from 'express';
import { TwilioService } from './twilio.service';
// Si ya tienes un UsersService/Firestore, puedes inyectarlo aquí para cargar firstInteractionUrl.

class IncomingDto {
  To?: string;
  From?: string;
  CallSid?: string;
}

@Controller('voice')
export class CallsController {
  constructor(private readonly twilio: TwilioService) {}

  @Post('incoming')
  incomming(@Body() body: IncomingDto, @Res() res: Response) {
    const r = this.twilio.newVoiceResponse();

    // TODO: Añadir primera interacción del usuario logueado.
    //r.play('https://TU_URL/first-interaction.mp3');

    // 1) Twilio Media Stream a tu WS NestJS:
    const start = r.start();
    start.stream({ url: 'wss://llamaloiabackend.onrender.com/voice/stream' });

    // 2) Mantener llamada viva (sin <Record>):
    r.pause({ length: 600 }); // 10 min

    res.type('text/xml').send(r.toString());
  }
}
