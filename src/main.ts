import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { getFirebaseApp } from './firebase/firebase.config'; // 👈 Inicializador global de Firebase
import * as bodyParser from 'body-parser';
import * as WebSocket from 'ws';
import { StreamsGateway } from './streams/streams.gateway';
import { configureLogging } from './utils/logging';

async function bootstrap() {
  // 🔥 Inicializa Firebase antes que cualquier otro servicio NestJS
  getFirebaseApp();

  configureLogging();

  console.log('🌐 Servidor HTTP y WS escuchando en /voice/stream');

  const app = await NestFactory.create(AppModule);

  // 🧠 Body parser (Twilio usa x-www-form-urlencoded)
  app.use(bodyParser.urlencoded({ extended: true, limit: '2mb' }));
  app.use(bodyParser.json({ limit: '2mb' }));

  // ✅ CORS — permite peticiones desde tu frontend
  app.enableCors({
    origin: ['https://app.llamalo.ai', 'http://localhost:4200'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // ✅ Swagger habilitable también en Render
  // Usa DISABLE_SWAGGER=true si quieres ocultarlo
  if (process.env.DISABLE_SWAGGER !== 'true') {
    const config = new DocumentBuilder()
      .setTitle('LlamaloAI API')
      .setDescription('Documentación de la API de autenticación y servicios')
      .setVersion('1.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api', app, document);
    console.log('📘 Swagger habilitado en /api');
  } else {
    console.log('🚀 Swagger desactivado por configuración');
  }

  // ✅ Render asigna dinámicamente el puerto (usa PORT si existe)
  const port = process.env.PORT || process.env.APP_PORT || 3000;
  const server = await app.listen(port, '0.0.0.0');
  console.log(`✅ LlamaloAI backend corriendo en el puerto ${port}`);

  // 🚀 Configurar WebSocket Server
  const wss = new WebSocket.Server({
    server,
    path: '/voice/stream',
  });

  wss.on('connection', (ws: WebSocket, req) => {
    console.log('🛰️ Nueva conexión WebSocket establecida');
    console.log('📡 Cliente conectado desde:', req.socket.remoteAddress);

    // Buffer para almacenar mensajes tempranos
    const earlyMessages: Buffer[] = [];
    let handlerRegistered = false;

    // Registrar listener INMEDIATAMENTE para capturar TODOS los mensajes
    ws.on('message', (data: WebSocket.Data) => {
      let buffer: Buffer;
      if (data instanceof Buffer) {
        buffer = data;
      } else if (typeof data === 'string') {
        buffer = Buffer.from(data, 'utf8');
      } else if (data instanceof ArrayBuffer) {
        buffer = Buffer.from(data);
      } else {
        buffer = Buffer.from(JSON.stringify(data), 'utf8');
      }

      // Si el handler ya está registrado, procesarlo directamente
      if (handlerRegistered && messageHandler) {
        messageHandler(buffer);
      } else {
        // Sino, guardarlo en el buffer
        earlyMessages.push(buffer);
      }
    });

    // Obtener instancia del StreamsGateway
    const streamsGateway = app.get(StreamsGateway);

    let messageHandler: ((data: Buffer) => void) | null = null;

    // Crear un objeto cliente compatible con StreamsGateway
    const client = {
      send: (data: string) => ws.send(data),
      on: (event: string, callback: (data: Buffer) => void) => {
        if (event === 'message') {
          // Guardar el callback
          messageHandler = callback;
          handlerRegistered = true;

          // Procesar mensajes acumulados
          for (const msg of earlyMessages) {
            callback(msg);
          }
          earlyMessages.length = 0; // Limpiar el buffer
        }
      },
      close: () => ws.close(),
    };

    // Delegar el manejo de la conexión al StreamsGateway
    try {
      streamsGateway.handleConnection(client);
    } catch (error) {
      console.error('❌ Error en StreamsGateway:', error);
    }

    ws.on('close', () => {
      console.log('🔌 Conexión WebSocket cerrada');
    });

    ws.on('error', (error) => {
      console.error('❌ Error en WebSocket:', error);
    });
  });

  console.log('🚀 WebSocket Server configurado en /voice/stream');
}

void bootstrap();
