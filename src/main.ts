import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const frontendOrigin = config.get<string>('FRONTEND_ORIGIN') || 'http://localhost:3000';

  app.enableCors({
    origin: frontendOrigin.split(',').map((origin) => origin.trim()),
    credentials: true,
  });
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  await app.listen(config.get<number>('PORT') || 4000);
}

void bootstrap();
