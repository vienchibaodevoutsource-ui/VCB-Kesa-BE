import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Tên schema lấy từ ?schema= trong DATABASE_URL (mặc định 'public').
 * Chỉ nhận ký tự an toàn vì giá trị này được nối thẳng vào SQL.
 */
function readSchemaName(): string {
  const raw = /[?&]schema=([^&]+)/.exec(process.env.DATABASE_URL || '')?.[1];
  const decoded = raw ? decodeURIComponent(raw) : 'public';
  return /^[A-Za-z0-9_]+$/.test(decoded) ? decoded : 'public';
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  /**
   * Schema của ứng dụng. Prisma Client tự ghi schema vào SQL nó sinh ra, nhưng raw SQL
   * thì không — mà search_path KHÔNG đáng tin khi đi qua transaction pooler
   * (pgbouncer=true, cổng 6543): Supavisor cấp lại connection cho từng transaction nên
   * lệnh SET search_path lúc mở kết nối có thể không còn hiệu lực, dẫn tới
   * `relation "Candidate" does not exist` (42P01). Vì vậy mọi raw query phải tự ghi schema.
   */
  readonly schema = readSchemaName();

  /** Tên bảng đã qualify schema, dùng trong raw SQL: `FROM ${prisma.table('Candidate')}`. */
  table(name: string) {
    return Prisma.raw(`"${this.schema}"."${name}"`);
  }

  constructor() {
    super({
      log:
        process.env.NODE_ENV === 'development'
          ? [{ emit: 'event', level: 'query' }, 'error', 'warn']
          : ['error'],
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
