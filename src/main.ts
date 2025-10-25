import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // ✅ Twilio envía datos en formato x-www-form-urlencoded (Nest lo maneja automáticamente desde v9)
  // Si tu endpoint Twilio funciona correctamente sin body-parser, no necesitas esto.
  // Si Twilio da error 400, puedes descomentar estas líneas:
  /*
  import * as bodyParser from 'body-parser';
  app.use(bodyParser.urlencoded({ extended: true, limit: '2mb' }));
  app.use(bodyParser.json({ limit: '2mb' }));
  */

  // ✅ CORS — permite peticiones desde tu frontend
  app.enableCors({
    origin: ['https://app.llamalo.ai', 'http://localhost:4200'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // ✅ Swagger solo en desarrollo o preproducción
  if (process.env.NODE_ENV !== 'production') {
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
    console.log('🚀 Swagger desactivado en producción');
  }

  // ✅ Render asigna dinámicamente el puerto (usa PORT si existe)
  const port = process.env.PORT || process.env.APP_PORT || 3000;
  await app.listen(port, '0.0.0.0');
  console.log(`✅ LlamaloAI backend corriendo en el puerto ${port}`);
}

void bootstrap();
