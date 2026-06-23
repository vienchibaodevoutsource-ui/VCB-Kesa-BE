import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  // Tắt body parser mặc định (giới hạn 100 KB) để tự đăng ký với limit lớn hơn bên dưới.
  // Hồ sơ kèm ảnh base64 (chân dung, tay/sẹo/hình xăm, formDataJson) thường vượt 100 KB → cần nâng limit.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(json({ limit: '25mb' }));
  app.use(urlencoded({ extended: true, limit: '25mb' }));
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
