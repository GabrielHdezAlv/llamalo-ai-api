import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as bodyParser from 'body-parser';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Middleware: necesario para que Twilio pueda enviar los webhooks correctamente
  app.use(bodyParser.urlencoded({ extended: true, limit: '2mb' })); // Twilio usa x-www-form-urlencoded
  app.use(bodyParser.json({ limit: '2mb' })); // tu API normal usa JSON

  // (Opcional) CORS: descomenta si lo necesitas para el front
  /*
  app.enableCors({
    origin: ['https://app.llamalo.ai', 'http://localhost:4200'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  */

  // Swagger setup
  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('LlamaloAI API')
      .setDescription('Documentación de la API de autenticación y servicios')
      .setVersion('1.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api', app, document); // Accedes con /api
  }

  const port = process.env.APP_PORT || 3000;
  await app.listen(port);
  console.log(`🚀 LlamaloAI backend corriendo en el puerto ${port}`);
}

void bootstrap();
