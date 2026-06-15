import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const GLOBAL_COUNTER_KEY = '__GLOBAL_CANDIDATE_CODE__';
const CODE_NUMBER_WIDTH = 2;

@Injectable()
export class CandidateCodesService {
  constructor(private readonly prisma: PrismaService) {}

  async getNextGlobalCodeNumber() {
    const rows = await this.prisma.$queryRaw<Array<{ next_number: number | bigint | null }>>`
      SELECT
        GREATEST(
          COALESCE((
            SELECT MAX((substring("candidateCode" from '([0-9]+)$'))::integer)
            FROM "Candidate"
            WHERE "candidateCode" IS NOT NULL
              AND "candidateCode" ~ '[0-9]+$'
          ), 0),
          COALESCE((
            SELECT MAX("count")
            FROM "CandidateCounter"
          ), 0)
        ) + 1 AS next_number
    `;
    return Number(rows[0]?.next_number ?? 1);
  }

  async generateCandidateCode(teamCode: string) {
    const rows = await this.prisma.$queryRaw<Array<{ count: number | bigint }>>`
      WITH max_existing AS (
        SELECT
          GREATEST(
            COALESCE((
              SELECT MAX((substring("candidateCode" from '([0-9]+)$'))::integer)
              FROM "Candidate"
              WHERE "candidateCode" IS NOT NULL
                AND "candidateCode" ~ '[0-9]+$'
            ), 0),
            COALESCE((
              SELECT MAX("count")
              FROM "CandidateCounter"
            ), 0)
          ) AS max_number
      ),
      upserted AS (
        INSERT INTO "CandidateCounter" ("id", "teamCode", "count", "updatedAt")
        SELECT gen_random_uuid()::text, ${GLOBAL_COUNTER_KEY}, max_number + 1, CURRENT_TIMESTAMP
        FROM max_existing
        ON CONFLICT ("teamCode") DO UPDATE
        SET
          "count" = GREATEST("CandidateCounter"."count", (SELECT max_number FROM max_existing)) + 1,
          "updatedAt" = CURRENT_TIMESTAMP
        RETURNING "count"
      )
      SELECT "count" FROM upserted
    `;
    return this.format(teamCode, Number(rows[0].count));
  }

  async withUniqueCandidateCode<T>(teamCode: string, write: (candidateCode: string) => Promise<T>, attempts = 5) {
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      const code = await this.generateCandidateCode(teamCode);
      try {
        return await write(code);
      } catch (error) {
        lastError = error;
        if (this.isUniqueError(error)) continue;
        throw error;
      }
    }
    throw lastError;
  }

  private format(teamCode: string, count: number) {
    return `${teamCode.trim().toUpperCase()}${String(count).padStart(CODE_NUMBER_WIDTH, '0')}`;
  }

  private isUniqueError(error: unknown) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
  }
}
