import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Configuración básica de Swagger
  const config = new DocumentBuilder()
    .setTitle('Mi API de LlamaloIA')
    .setDescription('Documentación de la API de autenticación y servicios')
    .setVersion('1.0')
    // .addBearerAuth()  // si luego quieres JWT
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document); // Accedes con /api

  await app.listen(process.env.APP_PORT || 3000);
}
void bootstrap();
