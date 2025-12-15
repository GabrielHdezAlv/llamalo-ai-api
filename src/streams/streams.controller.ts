import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

@Controller('voice')
export class StreamsController {
  @Get('stream')
  handleWebSocket(@Req() req: Request, @Res() res: Response) {
    console.log('🔌 Petición recibida en /voice/stream');
    console.log('🌐 URL:', req.url);
    console.log('🔍 Upgrade header:', req.headers.upgrade);
    console.log('🔍 Connection header:', req.headers.connection);

    // Verificar si es una petición de upgrade a WebSocket
    if (req.headers.upgrade === 'websocket') {
      console.log('✅ Es una petición de upgrade a WebSocket');
      res.status(426).json({
        error: 'WebSocket upgrade required',
        message: 'This endpoint requires WebSocket connection',
        upgrade: 'websocket',
      });
    } else {
      console.log('❌ No es una petición de upgrade a WebSocket');
      res.status(400).json({
        error: 'Bad Request',
        message: 'This endpoint only accepts WebSocket connections',
        received: {
          upgrade: req.headers.upgrade,
          connection: req.headers.connection,
        },
      });
    }
  }
}
