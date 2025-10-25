import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { getFirebaseApp } from './firebase/firebase.config'; // 👈 Importamos inicializador global

async function bootstrap() {
  // 🔥 Inicializa Firebase antes que cualquier otro servicio NestJS
  getFirebaseApp();

  const app = await NestFactory.create(AppModule);

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
