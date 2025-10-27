import { Controller, Get, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { StreamsGateway } from './streams.gateway';

@Controller('voice')
export class StreamsController {
  constructor(private readonly streamsGateway: StreamsGateway) {}

  @Get('stream')
  async handleWebSocket(@Req() req: Request, @Res() res: Response) {
    console.log('🔌 Petición WebSocket recibida');
    console.log('📋 Headers:', req.headers);
    console.log('🌐 URL:', req.url);
    
    // Verificar si es una petición de upgrade a WebSocket
    if (req.headers.upgrade === 'websocket') {
      console.log('✅ Es una petición de upgrade a WebSocket');
      // Aquí deberíamos manejar la conexión WebSocket
      // Por ahora, devolvemos un error 426 (Upgrade Required)
      res.status(426).json({ 
        error: 'WebSocket upgrade required',
        message: 'This endpoint requires WebSocket connection'
      });
    } else {
      console.log('❌ No es una petición de upgrade a WebSocket');
      res.status(400).json({ 
        error: 'Bad Request',
        message: 'This endpoint only accepts WebSocket connections'
      });
    }
  }
}
