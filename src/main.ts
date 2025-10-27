import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { getFirebaseApp } from './firebase/firebase.config'; // 👈 Inicializador global de Firebase
import * as bodyParser from 'body-parser';
import * as WebSocket from 'ws';
// import { StreamsGateway } from './streams/streams.gateway';

async function bootstrap() {
  // 🔥 Inicializa Firebase antes que cualquier otro servicio NestJS
  getFirebaseApp();

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
    console.log('🌐 URL:', req.url);
    console.log('📋 Headers:', req.headers);

    // TODO: Integrar con StreamsGateway cuando esté listo
    // const client = { ... };

    // Por ahora, solo manejamos la conexión básica
    // TODO: Integrar con StreamsGateway cuando esté listo
    ws.on('message', (data: WebSocket.Data) => {
      let message: string;
      if (data instanceof Buffer) {
        message = data.toString('utf8');
      } else if (typeof data === 'string') {
        message = data;
      } else {
        message = JSON.stringify(data);
      }
      console.log('📨 Mensaje WebSocket recibido:', message);
    });

    ws.on('close', () => {
      console.log('🔌 Conexión WebSocket cerrada');
    });

    ws.on('error', (error) => {
      console.error('❌ Error en WebSocket:', error);
    });

    // Enviar mensaje de confirmación
    ws.send(
      JSON.stringify({
        event: 'connected',
        message: 'WebSocket connection established',
      }),
    );
  });

  console.log('🚀 WebSocket Server configurado en /voice/stream');
}

void bootstrap();
