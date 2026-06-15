import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null) {
        const payload = body as Record<string, unknown>;
        response.status(status).json({
          error: payload.error ?? payload.message ?? exception.message,
          details: payload.details,
        });
        return;
      }
      response.status(status).json({ error: body });
      return;
    }

    const message = exception instanceof Error ? exception.message : 'Internal server error';
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: 'Internal server error',
      details: message,
    });
  }
}
