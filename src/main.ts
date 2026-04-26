// ⚠️ IMPORTANTE: `instrument` debe ir antes que cualquier otro import para
// que Sentry instrumente los módulos nativos de Node antes de ser cargados.
import './instrument';
import './bootstrap-gcp-credentials';
import * as Sentry from '@sentry/nestjs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { getFirebaseApp } from './firebase/firebase.config'; // 👈 Inicializador global de Firebase
import type { IncomingMessage } from 'http';
import * as bodyParser from 'body-parser';
import * as WebSocket from 'ws';
import { parse as parseUrl } from 'url';
import { StreamsGateway } from './streams/streams.gateway';
import { TestCallGateway } from './test-call/test-call.gateway';
import { SupportChatGateway } from './support-chat/support-chat.gateway';
import { ProfileEventsService } from './profile-events/profile-events.service';
import { configureLogging } from './utils/logging';

/** Normaliza un origen (sin barra final, con esquema). */
function normalizeOrigin(raw: string): string {
  let o = raw.trim().replace(/\/+$/, '');
  if (o && !/^https?:\/\//i.test(o)) {
    o = `https://${o}`;
  }
  return o;
}

/**
 * Orígenes CORS: FRONTEND_URL (coma-separado si hace falta) + localhost + Vercel
 * + CORS_EXTRA_ORIGINS (coma-separado) para previews u otros dominios.
 */
function buildCorsOrigins(): string[] {
  const raw = process.env.FRONTEND_URL?.trim();
  const fromFrontend = raw
    ? raw
        .split(',')
        .map((s) => normalizeOrigin(s))
        .filter(Boolean)
    : [normalizeOrigin('https://app.llamalo.ai')];
  const extraFromEnv = (process.env.CORS_EXTRA_ORIGINS ?? '')
    .split(',')
    .map((s) => normalizeOrigin(s))
    .filter(Boolean);
  /** Dominio por defecto del front en Vercel (producción del proyecto). */
  const vercelDefault = 'https://llamalo-ai.vercel.app';
  return Array.from(
    new Set([
      ...fromFrontend,
      'http://localhost:4200',
      vercelDefault,
      ...extraFromEnv,
    ]),
  );
}

async function bootstrap() {
  // 🔥 Inicializa Firebase antes que cualquier otro servicio NestJS
  getFirebaseApp();

  configureLogging();

  console.log('🌐 Servidor HTTP y WS escuchando en /voice/stream');

  const app = await NestFactory.create(AppModule);
  // Usar IP real del cliente detrás de proxy (Render/NGINX) para rate limiting.
  app.getHttpAdapter().getInstance().set('trust proxy', true);

  // 🧠 Body parser (Twilio usa x-www-form-urlencoded)
  app.use(bodyParser.urlencoded({ extended: true, limit: '2mb' }));
  // Raw body para webhooks Shopify: guardar buf en req.rawBody ANTES de parsear JSON (solo en /shopify/webhooks)
  app.use(
    bodyParser.json({
      limit: '2mb',
      verify: (req: IncomingMessage, _res, buf: Buffer, encoding: string) => {
        void encoding; // firma de body-parser exige 4º parámetro
        const r = req as IncomingMessage & {
          originalUrl?: string;
          rawBody?: Buffer;
        };
        if (
          r.originalUrl?.startsWith('/shopify/webhooks') ||
          r.originalUrl?.startsWith('/stripe/webhook')
        ) {
          r.rawBody = buf;
        }
      },
    }),
  );

  // ✅ CORS — FRONTEND_URL define el front de cada entorno en Render
  const corsOrigins = buildCorsOrigins();
  console.log(`CORS origins: ${corsOrigins.join(', ')}`);
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'],
    // Front (agents/knowledge-base): evita snackbar duplicado en 403 de plan; debe figurar en preflight
    // Sentry (browserTracingIntegration): inyecta `sentry-trace` y `baggage` para propagar la
    // traza distribuida hacia el backend; si no los permitimos aquí, el preflight CORS falla
    // y el navegador cancela TODAS las peticiones con body JSON al API (síntoma: "status (null)"
    // en Network y error "La cabecera 'baggage' no está permitida ..." en consola).
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Handles-Plan-403',
      'sentry-trace',
      'baggage',
    ],
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

  // 🚀 WebSocket Servers (noServer mode para evitar conflictos entre múltiples servidores)
  const wss = new WebSocket.Server({ noServer: true });
  const testWss = new WebSocket.Server({ noServer: true });
  const supportWss = new WebSocket.Server({ noServer: true });
  const profileEventsWss = new WebSocket.Server({ noServer: true });

  // Un único handler de upgrade que enruta al servidor correcto según la ruta
  server.on('upgrade', (request, socket, head) => {
    const { pathname } = parseUrl(request.url || '/');

    if (pathname === '/voice/stream') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else if (pathname === '/voice/test-stream') {
      testWss.handleUpgrade(request, socket, head, (ws) => {
        testWss.emit('connection', ws, request);
      });
    } else if (pathname === '/support/chat') {
      supportWss.handleUpgrade(request, socket, head, (ws) => {
        supportWss.emit('connection', ws, request);
      });
    } else if (pathname === '/profile/events') {
      profileEventsWss.handleUpgrade(request, socket, head, (ws) => {
        profileEventsWss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // 📞 Llamadas reales (Twilio Media Streams)
  wss.on('connection', (ws: WebSocket, req) => {
    console.log('🛰️ Nueva conexión WebSocket establecida');
    const remoteAddress = req.socket.remoteAddress;
    const maskedIp = remoteAddress
      ? remoteAddress.split('.').slice(0, 2).join('.') + '.***.***'
      : 'desconocida';
    console.log('📡 Cliente conectado desde:', maskedIp);

    const earlyMessages: Buffer[] = [];
    let handlerRegistered = false;

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

      if (handlerRegistered && messageHandler) {
        messageHandler(buffer);
      } else {
        earlyMessages.push(buffer);
      }
    });

    const streamsGateway = app.get(StreamsGateway);
    let messageHandler: ((data: Buffer) => void) | null = null;

    const client = {
      send: (data: string) => ws.send(data),
      on: (event: string, callback: (data: Buffer) => void) => {
        if (event === 'message') {
          messageHandler = callback;
          handlerRegistered = true;
          for (const msg of earlyMessages) {
            callback(msg);
          }
          earlyMessages.length = 0;
        }
      },
      close: () => ws.close(),
    };

    try {
      streamsGateway.handleConnection(client);
    } catch (error) {
      console.error('❌ Error en StreamsGateway:', error);
      Sentry.captureException(error, { tags: { gateway: 'streams' } });
    }

    ws.on('close', () => {
      console.log('🔌 Conexión WebSocket cerrada');
    });

    ws.on('error', (error) => {
      console.error('❌ Error en WebSocket:', error);
      Sentry.captureException(error, {
        tags: { gateway: 'streams', source: 'ws' },
      });
    });
  });

  console.log('🚀 WebSocket Server configurado en /voice/stream');

  // 🧪 Pruebas de llamada (sin Twilio, directo desde navegador)
  testWss.on('connection', (testWs: WebSocket) => {
    console.log('🧪 Nueva conexión WebSocket de prueba establecida');

    const testCallGateway = app.get(TestCallGateway);

    const client = {
      send: (data: string | Buffer) => {
        if (testWs.readyState === WebSocket.OPEN) {
          testWs.send(data);
        }
      },
      close: () => testWs.close(),
    };

    const onMessage = (callback: (data: Buffer) => void) => {
      testWs.on('message', (rawData: WebSocket.Data) => {
        let buffer: Buffer;
        if (rawData instanceof Buffer) {
          buffer = rawData;
        } else if (typeof rawData === 'string') {
          buffer = Buffer.from(rawData, 'utf8');
        } else if (rawData instanceof ArrayBuffer) {
          buffer = Buffer.from(rawData);
        } else {
          buffer = Buffer.from(JSON.stringify(rawData), 'utf8');
        }
        callback(buffer);
      });
    };

    testCallGateway.handleConnection(client, onMessage);

    testWs.on('close', () => {
      console.log('🔌 Conexión WebSocket de prueba cerrada');
      testCallGateway.handleDisconnect(client);
    });

    testWs.on('error', (error) => {
      console.error('❌ Error en WebSocket de prueba:', error);
      Sentry.captureException(error, {
        tags: { gateway: 'test-call', source: 'ws' },
      });
    });
  });

  console.log(
    '🧪 WebSocket Server de prueba configurado en /voice/test-stream',
  );

  // 💬 Chat de soporte (texto en tiempo real)
  supportWss.on('connection', (supportWs: WebSocket) => {
    console.log('💬 Nueva conexión WebSocket de soporte establecida');

    const supportChatGateway = app.get(SupportChatGateway);

    const client = {
      send: (data: string | Buffer) => {
        if (supportWs.readyState === WebSocket.OPEN) {
          supportWs.send(data);
        }
      },
      close: () => supportWs.close(),
    };

    const onMessage = (callback: (data: Buffer) => void) => {
      supportWs.on('message', (rawData: WebSocket.Data) => {
        let buffer: Buffer;
        if (rawData instanceof Buffer) {
          buffer = rawData;
        } else if (typeof rawData === 'string') {
          buffer = Buffer.from(rawData, 'utf8');
        } else if (rawData instanceof ArrayBuffer) {
          buffer = Buffer.from(rawData);
        } else {
          buffer = Buffer.from(JSON.stringify(rawData), 'utf8');
        }
        callback(buffer);
      });
    };

    supportChatGateway.handleConnection(client, onMessage);

    supportWs.on('close', () => {
      console.log('🔌 Conexión WebSocket de soporte cerrada');
      supportChatGateway.handleDisconnect(client);
    });

    supportWs.on('error', (error) => {
      console.error('❌ Error en WebSocket de soporte:', error);
      Sentry.captureException(error, {
        tags: { gateway: 'support-chat', source: 'ws' },
      });
    });
  });

  console.log('💬 WebSocket Server de soporte configurado en /support/chat');

  profileEventsWss.on('connection', (profileWs: WebSocket) => {
    const profileEvents = app.get(ProfileEventsService);
    profileEvents.handleConnection(profileWs);
    profileWs.on('error', (error) => {
      console.error('❌ Error en WebSocket profile/events:', error);
      Sentry.captureException(error, {
        tags: { gateway: 'profile-events', source: 'ws' },
      });
    });
  });

  console.log(
    '📣 WebSocket de eventos de perfil configurado en /profile/events',
  );
}

void bootstrap();
