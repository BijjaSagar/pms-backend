import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Security headers
  app.use(helmet());

  // Cookie parsing
  app.use(cookieParser());

  // CORS for frontend and trusted origins
  const allowedOrigins = (process.env['FRONTEND_URL'] ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept', 'Authorization', 'X-Requested-With', 'X-Request-Id'],
  });

  // API prefix
  app.setGlobalPrefix('api/v1');

  // Global validation pipe
  // `enableImplicitConversion` is deliberately OFF. With it on, class-transformer
  // coerces any unexpected value to a string before validation runs, so an
  // object in a string field becomes the literal "[object Object]", passes
  // @IsString(), and only fails deep inside the database driver. DTOs that need
  // numbers declare @Type(() => Number) explicitly instead.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: false,
      },
    }),
  );

  // Swagger in development only
  if (process.env['NODE_ENV'] !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('TriponX API')
      .setDescription('TriponX Property Management System API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document);
  }

  const port = process.env['PORT'] ?? 3000;
  await app.listen(port);
  console.log(`Application running on: http://localhost:${port}/api/v1`);
  console.log(`Swagger docs at: http://localhost:${port}/docs`);
}

await bootstrap();
