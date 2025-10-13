import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Configuración de CORS
  /*app.enableCors({
    origin: ['https://app.llamalo.ai', 'http://localhost:4200'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });*/

  // Configuración básica de Swagger
  const config = new DocumentBuilder()
    .setTitle('LlamaloAI API')
    .setDescription('Documentación de la API de autenticación y servicios')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document); // Accedes con /api

  await app.listen(process.env.APP_PORT || 3000);
}
void bootstrap();
