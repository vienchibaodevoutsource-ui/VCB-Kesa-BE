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
        // NestJS gắn lý do thật vào `message`, còn `error` chỉ là tên trạng thái ("Bad Request").
        // Ưu tiên `message` để FE hiển thị đúng nguyên nhân thay vì câu generic.
        const message = payload.message ?? payload.error ?? exception.message;
        response.status(status).json({
          error: Array.isArray(message) ? message.join(', ') : message,
          details: payload.details,
        });
        return;
      }
      response.status(status).json({ error: body });
      return;
    }

    // body-parser ném PayloadTooLargeError khi body vượt limit → trả 413 rõ ràng thay vì 500 mơ hồ.
    const err = exception as { type?: string; status?: number; statusCode?: number };
    if (err?.type === 'entity.too.large' || err?.status === 413 || err?.statusCode === 413) {
      response.status(HttpStatus.PAYLOAD_TOO_LARGE).json({
        error: 'Hồ sơ hoặc ảnh quá lớn, vui lòng giảm dung lượng ảnh rồi thử lại.',
      });
      return;
    }

    const message = exception instanceof Error ? exception.message : 'Internal server error';
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: 'Internal server error',
      details: message,
    });
  }
}
