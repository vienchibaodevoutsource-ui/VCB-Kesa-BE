import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CandidateStatus, Prisma } from '@prisma/client';
import { CandidateCodesService } from '../candidate-codes/candidate-codes.service';
import { AuthUser } from '../common/types';
import { clampPage } from '../common/utils/pagination';
import { buildCandidateNameSearch, dobVariants, normalizeSearch, personNameKey } from '../common/utils/normalize';
import { normalizeTeamCode, validateTeamCodeFormat } from '../common/utils/team-code';
import { FormsService } from '../forms/forms.service';
import { PrismaService } from '../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import { sanitizeImageValues } from '../common/utils/image-sanitizer';

// Xoá mềm: hồ sơ có deletedAt nằm trong "Thùng rác". Mọi truy vấn hồ sơ đang dùng phải kèm điều kiện này.
// Ngoại lệ có chủ đích: bộ đếm mã hồ sơ (candidate-codes) và isImageShared vẫn tính cả hồ sơ đã xoá —
// để không cấp lại mã cũ và không xoá ảnh của hồ sơ còn có thể được khôi phục.
const NOT_DELETED = { deletedAt: null };

// Hồ sơ đã chuyển đi (bản mới đã Lưu) — để gắn nhãn "Đã chuyển → Nhà máy B".
const transfersSelect = {
  where: { status: 'COMPLETED' as const, deletedAt: null },
  orderBy: { createdAt: 'desc' as const },
  take: 1,
  select: {
    id: true,
    candidateCode: true,
    broker: { select: { name: true } },
    factory: { select: { name: true } },
  },
};

const candidateInclude = {
  familyMembers: true,
  source: {
    select: {
      id: true,
      candidateCode: true,
      broker: { select: { name: true } },
      factory: { select: { name: true } },
    },
  },
  transfers: transfersSelect,
  broker: true,
  factory: true,
  createdBy: { select: { id: true, name: true, email: true, role: true, teamCode: true } },
  team: { select: { id: true, code: true, label: true, isActive: true } },
  formSnapshot: true,
} as const;
const candidateListInclude = {
  broker: { select: { id: true, name: true, chineseName: true, slug: true } },
  factory: { select: { id: true, name: true, chineseName: true, slug: true } },
} as const;

const candidateListSelect = {
  id: true,
  candidateCode: true,
  teamCode: true,
  vietnameseName: true,
  chineseName: true,
  company: true,
  brokerId: true,
  factoryId: true,
  broker: candidateListInclude.broker,
  factory: candidateListInclude.factory,
  gender: true,
  dateOfBirth: true,
  age: true,
  height: true,
  weight: true,
  education: true,
  maritalStatus: true,
  address: true,
  phone: true,
  createdAt: true,
  lastSavedAt: true,
  status: true,
  isVerified: true,
  verifiedById: true,
  verifiedByName: true,
  verifiedAt: true,
  applicantGroupId: true,
  sourceCandidateId: true,
  transfers: transfersSelect,
  lineImageUrl: true,
  domesticExperience: true,
  overseasExperience: true,
  note: true,
  deletedAt: true,
  deletedByName: true,
  // KHÔNG select formDataJson / formSnapshot.data ở đây: 2 cột này nhúng ảnh base64
  // (mỗi hồ sơ tới ~25MB). Đọc nguyên blob mỗi lần list = đốt egress Supabase.
  // 4 trường hiển thị (mathScore/beanCount/lensCheck/shiftChoice) được trích riêng
  // ở tầng Postgres qua fetchCompactListFormData() nên chỉ truyền vài byte.
} as const;

// Endpoint "lấy toàn bộ hồ sơ" (không phân trang) phục vụ dashboard + trang xuất danh sách.
// Các trang này chỉ dùng field text nhẹ, nên tuyệt đối KHÔNG kèm base64/ảnh/snapshot.
const candidateAllSelect = {
  id: true,
  candidateCode: true,
  teamCode: true,
  vietnameseName: true,
  chineseName: true,
  company: true,
  broker: { select: { name: true } },
  factory: { select: { name: true } },
  gender: true,
  dateOfBirth: true,
  age: true,
  height: true,
  weight: true,
  education: true,
  maritalStatus: true,
  address: true,
  createdAt: true,
} as const;

// Các khóa nhỏ cần trích từ JSON form (riêng biểu mẫu Vĩnh Thắng) để hiển thị ở bảng danh sách.
const COMPACT_LIST_KEYS = ['mathScore', 'beanCount', 'lensCheck', 'shiftChoice'] as const;
const DRAFT_PLACEHOLDER_NAME = '(Dang nhap)';
const TRANSFER_REASON_MAX = 500;
// Khóa trong snapshot JSON gắn với nhà máy/hồ sơ cũ — bỏ khi nhân bản sang nhà máy khác.
const REAPPLY_STRIP_SNAPSHOT_KEYS = ['candidateCode', 'interviewResult', 'brokerId', 'factoryId', 'company', 'formType'] as const;

// Candidate writes embed base64 images (payload up to ~25MB), so the candidate
// create/update + form-snapshot upsert can exceed Prisma's default 5s interactive
// transaction limit. Ảnh đã được đẩy lên Cloudinary TRƯỚC khi mở transaction
// (sanitizeWriteImages), nên trong transaction chỉ còn 2 câu ghi — 15s là rộng rãi.
// Không nới thêm: transaction giữ connection suốt thời gian đó, mà pool chỉ vài chỗ,
// nên timeout dài biến một hồ sơ lỗi thành nghẽn cả app ("Timed out fetching a new
// connection from the connection pool").
const CANDIDATE_TX_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;

type DupScope = { brokerId?: string | null; factoryId?: string | null };

export interface CandidateFilterOptions {
  educations: string[];
  brokers: { id: string; name: string; chineseName: string | null }[];
}

// filterOptions (học lực + môi giới) hầu như không đổi nhưng tốn 1 distinct quét cả bảng + 1 query brokers.
// Cache trong bộ nhớ với TTL ngắn để các lần load danh sách kế tiếp không phải truy vấn lại.
const FILTER_OPTIONS_TTL_MS = 60_000;

@Injectable()
export class CandidatesService {
  private filterOptionsCache: { value: CandidateFilterOptions; expires: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly codes: CandidateCodesService,
    private readonly forms: FormsService,
    private readonly uploads: UploadsService,
  ) {}

  // Wrap candidate write transactions with an extended timeout (see CANDIDATE_TX_OPTIONS).
  private candidateTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn, CANDIDATE_TX_OPTIONS);
  }

  async list(query: Record<string, unknown>, user?: AuthUser) {
    if (query.statsOnly === '1') {
      return { stats: await this.getStats() };
    }

    // Thùng rác (hồ sơ đã xoá mềm) chỉ Admin được xem.
    if (query.trash === '1' && user?.role !== 'ADMIN') {
      throw new ForbiddenException('Chi Admin moi xem duoc thung rac');
    }

    if (!this.isCandidateListRequest(query)) {
      return {
        data: await this.prisma.candidate.findMany({
          where: NOT_DELETED,
          orderBy: { createdAt: 'desc' },
          select: candidateAllSelect,
        }),
      };
    }

    const page = Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1);
    // FE chỉ chọn tối đa 50 bản/trang; giới hạn 200 để tránh 1 request kéo quá nhiều dữ liệu.
    const pageSize = Math.min(200, Math.max(1, Number.parseInt(String(query.pageSize ?? '10'), 10) || 10));
    const sortBy = String(query.sortBy ?? 'newest');
    const where = await this.buildWhere(query);
    // Thùng rác: mặc định xếp theo lúc xoá, mới xoá lên đầu.
    const orderBy: Prisma.CandidateOrderByWithRelationInput[] =
      query.trash === '1' && sortBy === 'newest' ? [{ deletedAt: 'desc' }] : this.buildOrderBy(sortBy);
    const includeStats = query.stats !== '0';

    // count chạy SONG SONG với findMany thay vì chặn trước nó: mỗi lượt đi-về qua pooler
    // tốn vài trăm ms nên bớt được một lượt là bớt đáng kể thời gian phản hồi.
    // Đổi lại phải đoán trang trước khi biết total; nếu trang vượt quá thì lấy lại đúng
    // trang cuối — trường hợp hiếm nên không ảnh hưởng đường đi thường gặp.
    const page_ = Math.max(1, page);
    const [total, firstPass, stats] = await Promise.all([
      this.prisma.candidate.count({ where }),
      this.prisma.candidate.findMany({
        where,
        orderBy,
        skip: (page_ - 1) * pageSize,
        take: pageSize,
        select: candidateListSelect,
      }),
      includeStats ? this.getStats() : Promise.resolve(null),
    ]);

    const { page: safePage } = clampPage(page_, total, pageSize);
    const data =
      safePage === page_
        ? firstPass
        : await this.prisma.candidate.findMany({
            where,
            orderBy,
            skip: (safePage - 1) * pageSize,
            take: pageSize,
            select: candidateListSelect,
          });

    const compactMap = await this.fetchCompactListFormData(data.map((c) => c.id));

    return {
      data: data.map((candidate) => ({
        ...candidate,
        formDataJson: compactMap.get(candidate.id) ?? null,
      })),
      total,
      page: safePage,
      pageSize,
      ...(stats ? { stats } : {}),
    };
  }

  // Trích 4 khóa nhỏ từ JSON form NGAY TRÊN Postgres (toán tử ->>) thay vì kéo cả cột
  // formDataJson/snapshot.data (nhúng base64) về BE. Nhờ vậy egress chỉ vài byte/hồ sơ.
  // Ưu tiên snapshot.data (jsonb, luôn hợp lệ); rơi về formDataJson cho hồ sơ cũ chưa có snapshot.
  private async fetchCompactListFormData(ids: string[]): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    if (ids.length === 0) return result;

    const buildCompact = (row: Record<string, string | null>) => {
      const compact: Record<string, string | null> = {};
      let hasValue = false;
      for (const key of COMPACT_LIST_KEYS) {
        const value = row[key];
        compact[key] = value ?? null;
        if (value !== null && value !== undefined && String(value).trim()) hasValue = true;
      }
      return hasValue ? JSON.stringify(compact) : null;
    };

    try {
      const snapRows = await this.prisma.$queryRaw<Array<Record<string, string | null>>>(Prisma.sql`
        SELECT "candidateId" AS id,
               "data"->>'mathScore'   AS "mathScore",
               "data"->>'beanCount'   AS "beanCount",
               "data"->>'lensCheck'   AS "lensCheck",
               "data"->>'shiftChoice' AS "shiftChoice"
        FROM ${this.prisma.table('CandidateFormSnapshot')}
        WHERE "candidateId" IN (${Prisma.join(ids)})
      `);
      for (const row of snapRows) {
        if (row.id) result.set(row.id, buildCompact(row));
      }
    } catch (error) {
      // Danh sách vẫn hiển thị được (rơi xuống nhánh đọc formDataJson bên dưới), nhưng nhánh đó
      // nặng hơn nhiều nên lỗi ở đây biểu hiện ra ngoài thành "tải rất chậm". Đừng nuốt im lặng.
      console.error(
        '[candidates] trích JSON từ snapshot lỗi, phải đọc formDataJson cho',
        ids.length,
        'hồ sơ:',
        error instanceof Error ? error.message : error,
      );
    }

    // Hồ sơ cũ chưa có snapshot: đọc formDataJson (text) chỉ cho những id còn thiếu.
    const missing = ids.filter((id) => !result.has(id));
    if (missing.length) {
      const legacy = await this.prisma.candidate.findMany({
        where: { id: { in: missing } },
        select: { id: true, formDataJson: true },
      });
      for (const row of legacy) result.set(row.id, this.compactListFormData(row.formDataJson));
    }

    return result;
  }

  async get(id: string) {
    // relationLoadStrategy 'join': lấy cả 6 quan hệ trong MỘT câu SQL. Mặc định ('query')
    // phát mỗi quan hệ một câu, mà mỗi lượt đi-về qua transaction pooler tốn 300-500ms
    // nên riêng việc mở một hồ sơ đã ngốn vài giây.
    const candidate = await this.prisma.candidate.findUnique({
      where: { id, ...NOT_DELETED },
      include: candidateInclude,
      relationLoadStrategy: 'join',
    });
    if (!candidate) throw new NotFoundException('Not found');
    return this.withLegacyFormDataJson(candidate);
  }

  async create(body: Record<string, unknown>, user: AuthUser) {
    const { familyMembers, teamCode, data } = this.cleanCandidatePayload(body);
    const formSnapshot = await this.sanitizeWriteImages(data, this.takeFormSnapshot(data));
    const brokerId = this.stringValue(data.brokerId);
    const factoryId = this.stringValue(data.factoryId);
    await this.validateBrokerFactory(brokerId, factoryId);
    await this.assertNoTripleDuplicate(data, undefined, { brokerId, factoryId });
    await this.validateRequestedTeam(teamCode);
    const resolvedTeamCode = (await this.resolveTeamForCode(teamCode, user)) || null;
    if (!resolvedTeamCode) throw new BadRequestException('Vui long chon ma to ho so (Team Code)');

    const buildCreate = (candidateCode?: string) =>
      this.candidateTx(async (tx) => {
        const candidate = await tx.candidate.create({
          data: {
            ...data,
            factoryId,
            nameSearch: this.computeNameSearch(data),
            candidateCode: candidateCode ?? null,
            teamCode: resolvedTeamCode,
            status: 'COMPLETED',
            draftSessionId: null,
            lastSavedAt: new Date(),
            createdByUserId: user.id,
            familyMembers: familyMembers?.length ? { create: familyMembers } : undefined,
          } as unknown as Prisma.CandidateCreateInput,
          include: candidateInclude,
        });
        await this.upsertFormSnapshot(tx, candidate.id, formSnapshot);
        return this.withLegacyFormDataJson({ ...candidate, formSnapshot: formSnapshot ? this.snapshotRow(formSnapshot) : candidate.formSnapshot });
      });

    // Mã hồ sơ luôn do BE cấp theo bộ đếm toàn cục (không nhận mã trình duyệt gửi lên).
    return this.codes.withUniqueCandidateCode(resolvedTeamCode, buildCreate);
  }

  async createDraft(body: Record<string, unknown>, user: AuthUser) {
    const formSnapshot = await this.sanitizeWriteImages(null, this.takeFormSnapshot(body));
    const requestedTeam = typeof body.teamCode === 'string' ? body.teamCode : undefined;
    await this.validateRequestedTeam(requestedTeam);
    const resolvedTeamCode = (await this.resolveTeamForCode(requestedTeam, user)) || null;
    const draftSessionId = this.stringValue(body.draftSessionId);
    const brokerId = this.stringValue(body.brokerId);
    const factoryId = this.stringValue(body.factoryId);
    if (!draftSessionId) throw new BadRequestException('Thieu draftSessionId');
    if (!brokerId || !factoryId) throw new BadRequestException('Thieu brokerId hoac factoryId');
    await this.validateBrokerFactory(brokerId, factoryId, true);
    return this.candidateTx(async (tx) => {
      const candidate = await tx.candidate.create({
        data: {
          status: 'DRAFT',
          draftSessionId,
          createdByUserId: user.id,
          lastSavedAt: new Date(),
          vietnameseName: this.stringValue(body.vietnameseName) || DRAFT_PLACEHOLDER_NAME,
          nameSearch: buildCandidateNameSearch([this.stringValue(body.vietnameseName), this.stringValue(body.chineseName)]) || null,
          gender: this.stringValue(body.gender) || 'Nam',
          company: this.stringValue(body.company),
          candidateCode: null,
          teamCode: resolvedTeamCode,
          brokerId,
          factoryId,
        } as unknown as Prisma.CandidateCreateInput,
        include: candidateInclude,
      });
      await this.upsertFormSnapshot(tx, candidate.id, formSnapshot);
      return this.withLegacyFormDataJson({ ...candidate, formSnapshot: formSnapshot ? this.snapshotRow(formSnapshot) : null });
    });
  }

  async autosaveDraft(id: string, body: Record<string, unknown>, user: AuthUser) {
    const existing = await this.prisma.candidate.findUnique({ where: { id, ...NOT_DELETED } });
    if (!existing) throw new NotFoundException('Not found');
    if (existing.status !== 'DRAFT') throw new BadRequestException('Chi co the autosave ho so draft');

    const draftSessionId = this.stringValue(body.draftSessionId);
    if (!draftSessionId || !this.canContinueDraft(existing, draftSessionId, user)) {
      throw new ForbiddenException('Khong co quyen cap nhat ho so draft nay');
    }

    const { familyMembers, teamCode, data } = this.cleanCandidatePayload(body);
    const formSnapshot = await this.sanitizeWriteImages(data, this.takeFormSnapshot(data));
    delete data.status;
    delete data.draftSessionId;

    let generatedCode: string | undefined;
    await this.validateRequestedTeam(teamCode);
    const teamForNewCode = (await this.resolveTeamForCode(teamCode, user)) || existing.teamCode || null;
    // Đã có mã → tổ bám tiền tố mã (chống trôi); chưa có mã → dùng tổ trên để sinh mã mới.
    const knownCode = existing.candidateCode;
    const resolvedTeamCode = this.teamPrefixFromCode(knownCode) ?? teamForNewCode;

    if (!existing.candidateCode) {
      if (resolvedTeamCode) generatedCode = await this.codes.generateCandidateCode(resolvedTeamCode);
    }

    await this.prisma.familyMember.deleteMany({ where: { candidateId: id } });
    return this.candidateTx(async (tx) => {
      const candidate = await tx.candidate.update({
        where: { id },
        data: {
          ...data,
          candidateCode: generatedCode ?? existing.candidateCode ?? null,
          nameSearch: this.computeNameSearch(data, existing.vietnameseName),
          teamCode: resolvedTeamCode,
          status: 'DRAFT',
          draftSessionId,
          lastSavedAt: new Date(),
          createdByUserId: existing.createdByUserId ?? user.id,
          familyMembers: familyMembers?.length ? { create: familyMembers } : undefined,
        } as Prisma.CandidateUpdateInput,
        include: candidateInclude,
      });
      await this.upsertFormSnapshot(tx, id, formSnapshot);
      return this.withLegacyFormDataJson({ ...candidate, formSnapshot: formSnapshot ? this.snapshotRow(formSnapshot) : candidate.formSnapshot });
    });
  }

  async update(id: string, body: Record<string, unknown>, user: AuthUser) {
    const existing = await this.prisma.candidate.findUnique({ where: { id, ...NOT_DELETED } });
    if (!existing) throw new NotFoundException('Not found');
    this.assertCanEdit(existing, user);
    const { familyMembers, teamCode, data } = this.cleanCandidatePayload(body);
    const formSnapshot = await this.sanitizeWriteImages(data, this.takeFormSnapshot(data));
    delete data.draftSessionId;
    await this.assertNoTripleDuplicate(data, id, this.dupScope(data, existing));
    await this.validateRequestedTeam(teamCode);
    // Đã có mã hồ sơ → tổ luôn bám tiền tố mã (chống trôi theo tổ người sửa); chưa có mã → theo yêu cầu/cột cũ.
    const storedCode = existing.candidateCode;
    const resolvedTeamCode =
      this.teamPrefixFromCode(storedCode) ?? (teamCode ? normalizeTeamCode(teamCode) : existing.teamCode);
    await this.prisma.familyMember.deleteMany({ where: { candidateId: id } });
    return this.candidateTx(async (tx) => {
      const candidate = await tx.candidate.update({
        where: { id },
        data: {
          ...data,
          status: (data.status as CandidateStatus | undefined) ?? 'COMPLETED',
          nameSearch: this.computeNameSearch(data, existing.vietnameseName),
          teamCode: resolvedTeamCode ?? null,
          lastSavedAt: new Date(),
          familyMembers: familyMembers?.length ? { create: familyMembers } : undefined,
        } as Prisma.CandidateUpdateInput,
        include: candidateInclude,
      });
      await this.upsertFormSnapshot(tx, id, formSnapshot);
      return this.withLegacyFormDataJson({ ...candidate, formSnapshot: formSnapshot ? this.snapshotRow(formSnapshot) : candidate.formSnapshot });
    });
  }

  async complete(id: string, body: Record<string, unknown>, user: AuthUser) {
    const existing = await this.prisma.candidate.findUnique({ where: { id, ...NOT_DELETED } });
    if (!existing) throw new NotFoundException('Not found');
    this.assertCanEdit(existing, user);
    const draftSessionId = this.stringValue(body.draftSessionId);
    if (existing.status === 'DRAFT' && !this.canContinueDraft(existing, draftSessionId, user)) {
      throw new ForbiddenException('Khong co quyen hoan tat ho so draft nay');
    }

    const { familyMembers, teamCode, data } = this.cleanCandidatePayload(body);
    const formSnapshot = await this.sanitizeWriteImages(data, this.takeFormSnapshot(data));
    delete data.status;
    delete data.draftSessionId;
    if (!this.stringValue(data.vietnameseName) || data.vietnameseName === DRAFT_PLACEHOLDER_NAME) {
      throw new BadRequestException('Vui long nhap ho ten ung vien');
    }
    await this.assertNoTripleDuplicate(data, id, this.dupScope(data, existing));
    await this.validateRequestedTeam(teamCode);
    const teamForNewCode = (await this.resolveTeamForCode(teamCode, user)) || existing.teamCode || null;
    // Đã có mã → tổ bám tiền tố mã (chống trôi); chưa có mã → dùng tổ trên để sinh mã mới.
    const knownCode = existing.candidateCode;
    const resolvedTeamCode = this.teamPrefixFromCode(knownCode) ?? teamForNewCode;
    if (!resolvedTeamCode) throw new BadRequestException('Vui long chon ma to ho so (Team Code)');
    await this.prisma.familyMember.deleteMany({ where: { candidateId: id } });

    const buildUpdate = (candidateCode?: string) =>
      this.candidateTx(async (tx) => {
        const candidate = await tx.candidate.update({
          where: { id },
          data: {
            ...data,
            candidateCode: candidateCode ?? existing.candidateCode ?? null,
            nameSearch: this.computeNameSearch(data, existing.vietnameseName),
            teamCode: resolvedTeamCode,
            status: 'COMPLETED',
            draftSessionId: null,
            lastSavedAt: new Date(),
            createdByUserId: existing.createdByUserId ?? user.id,
            familyMembers: familyMembers?.length ? { create: familyMembers } : undefined,
          } as Prisma.CandidateUpdateInput,
          include: candidateInclude,
        });
        await this.upsertFormSnapshot(tx, id, formSnapshot);
        return this.withLegacyFormDataJson({ ...candidate, formSnapshot: formSnapshot ? this.snapshotRow(formSnapshot) : candidate.formSnapshot });
      });

    if (!existing.candidateCode) {
      if (resolvedTeamCode) return this.codes.withUniqueCandidateCode(resolvedTeamCode, buildUpdate);
    }
    return buildUpdate();
  }

  // Xoá MỀM: chỉ đánh dấu deletedAt — dữ liệu, bảng con (người thân, snapshot, đẩy 長青…) và ảnh
  // đều giữ nguyên để Admin khôi phục được từ "Thùng rác". Không dọn ảnh ở đây.
  async remove(id: string, user?: AuthUser) {
    // updateMany + điều kiện deletedAt = null: xoá lặp (bấm 2 lần / 2 tab cùng xoá) không ghi đè
    // người/thời điểm xoá đầu tiên và không ném lỗi.
    const { count } = await this.prisma.candidate.updateMany({
      where: { id, ...NOT_DELETED },
      data: { deletedAt: new Date(), deletedById: user?.id ?? null, deletedByName: user?.name ?? null },
    });
    if (count === 0) {
      const exists = await this.prisma.candidate.findUnique({ where: { id }, select: { id: true } });
      if (!exists) throw new NotFoundException('Not found');
      return { success: true, alreadyDeleted: true };
    }
    return { success: true };
  }

  // Khôi phục hồ sơ từ Thùng rác (chỉ Admin — guard đặt ở controller).
  async restore(id: string) {
    const doomed = await this.prisma.candidate.findUnique({
      where: { id },
      select: { deletedAt: true, status: true, vietnameseName: true, dateOfBirth: true, brokerId: true, factoryId: true },
    });
    if (!doomed) throw new NotFoundException('Not found');
    if (!doomed.deletedAt) return { success: true, alreadyRestored: true };
    // Trong lúc hồ sơ nằm thùng rác có thể đã có người nhập lại đúng người đó ở cùng nhà máy → chặn để không sinh trùng.
    if (doomed.status === 'COMPLETED') {
      await this.assertNoTripleDuplicate(
        { vietnameseName: doomed.vietnameseName, dateOfBirth: doomed.dateOfBirth },
        id,
        { brokerId: doomed.brokerId, factoryId: doomed.factoryId },
      );
    }
    await this.prisma.candidate.update({
      where: { id },
      data: { deletedAt: null, deletedById: null, deletedByName: null },
    });
    return { success: true };
  }

  // Kiểm duyệt / bỏ kiểm duyệt hồ sơ. Chỉ Admin hoặc tài khoản được cấp quyền (canModerate) mới được phép.
  async setVerified(id: string, verified: boolean, user: AuthUser) {
    const actor = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { role: true, canModerate: true, name: true },
    });
    const allowed = actor?.role === 'ADMIN' || actor?.canModerate === true;
    if (!allowed) throw new ForbiddenException('Tai khoan khong co quyen kiem duyet');

    const existing = await this.prisma.candidate.findUnique({ where: { id, ...NOT_DELETED }, select: { id: true } });
    if (!existing) throw new NotFoundException('Not found');

    const candidate = await this.prisma.candidate.update({
      where: { id },
      data: verified
        ? { isVerified: true, verifiedById: user.id, verifiedByName: actor?.name ?? user.name, verifiedAt: new Date() }
        : { isVerified: false, verifiedById: null, verifiedByName: null, verifiedAt: null },
      include: candidateInclude,
    });
    return this.withLegacyFormDataJson(candidate);
  }

  // Chuyển hồ sơ sang công ty/nhà máy khác: nhân bản thành một hồ sơ NHÁP mới ở nhà máy mới, điền sẵn
  // toàn bộ dữ liệu + lý do chuyển. Hồ sơ cũ giữ nguyên (nhãn "Đã chuyển"). Người dùng rà lại rồi Lưu → complete() cấp mã mới.
  async reapply(id: string, body: Record<string, unknown>, user: AuthUser) {
    const brokerId = this.stringValue(body.brokerId);
    const factoryId = this.stringValue(body.factoryId);
    const draftSessionId = this.stringValue(body.draftSessionId);
    if (!draftSessionId) throw new BadRequestException('Thieu draftSessionId');
    const reason = this.stringValue(body.reason);
    if (!reason) throw new BadRequestException('Vui long nhap ly do chuyen ho so');
    if (reason.length > TRANSFER_REASON_MAX) throw new BadRequestException(`Ly do chuyen toi da ${TRANSFER_REASON_MAX} ky tu`);

    const source = await this.prisma.candidate.findUnique({
      where: { id, ...NOT_DELETED },
      include: { familyMembers: true, formSnapshot: true },
    });
    if (!source) throw new NotFoundException('Not found');
    if (source.status !== 'COMPLETED') throw new BadRequestException('Chi chuyen duoc ho so da hoan tat');

    await this.validateBrokerFactory(brokerId, factoryId);
    const [broker, factory] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: brokerId! }, select: { name: true, slug: true, formType: true } }),
      factoryId ? this.prisma.company.findUnique({ where: { id: factoryId }, select: { slug: true } }) : null,
    ]);

    // Một người chỉ có một hồ sơ trong chuỗi ứng tuyển ở mỗi nhà máy (tính cả nháp → chống bấm 2 lần).
    const groupId = source.applicantGroupId ?? source.id;
    const sameTarget: Prisma.CandidateWhereInput = factoryId ? { factoryId } : { brokerId, factoryId: null };
    const inGroup = await this.prisma.candidate.findFirst({
      where: { OR: [{ applicantGroupId: groupId }, { id: groupId }], ...sameTarget, ...NOT_DELETED },
      select: { id: true, candidateCode: true, status: true },
    });
    if (inGroup) {
      const code = inGroup.candidateCode ? ` (ma ${inGroup.candidateCode})` : inGroup.status === 'DRAFT' ? ' (ban nhap)' : '';
      throw new ConflictException(`Nguoi lao dong da co ho so o nha may nay${code}`);
    }
    // Hồ sơ trùng do người khác nhập tay ở nhà máy mới → báo sớm thay vì đợi lúc Lưu.
    await this.assertNoTripleDuplicate(
      { vietnameseName: source.vietnameseName, dateOfBirth: source.dateOfBirth },
      undefined,
      { brokerId, factoryId },
    );

    const formType = this.forms.resolveFormType({
      brokerSlug: broker?.slug,
      brokerFormType: broker?.formType,
      factorySlug: factory?.slug,
    });
    const snapshotData = this.reapplySnapshotData(source.formSnapshot?.data, source.formDataJson, formType);
    const teamCode = (await this.resolveTeamForCode(body.teamCode, user)) || source.teamCode || null;

    const {
      id: _id,
      candidateCode: _code,
      status: _status,
      draftSessionId: _draft,
      createdByUserId: _createdBy,
      teamCode: _team,
      lastSavedAt: _lastSaved,
      isVerified: _isVerified,
      verifiedById: _verifiedById,
      verifiedByName: _verifiedByName,
      verifiedAt: _verifiedAt,
      sourceCandidateId: _sourceId,
      transferReason: _reason,
      deletedAt: _deletedAt,
      deletedById: _deletedById,
      deletedByName: _deletedByName,
      applicantGroupId: _groupId,
      brokerId: _brokerId,
      factoryId: _factoryId,
      company: _company,
      formDataJson: _formDataJson,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      familyMembers,
      formSnapshot: _snapshot,
      ...profile
    } = source;

    return this.candidateTx(async (tx) => {
      if (!source.applicantGroupId) {
        await tx.candidate.update({ where: { id: source.id }, data: { applicantGroupId: groupId } });
      }
      const candidate = await tx.candidate.create({
        data: {
          ...profile,
          status: 'DRAFT',
          draftSessionId,
          createdByUserId: user.id,
          lastSavedAt: new Date(),
          candidateCode: null,
          teamCode,
          company: broker?.name ?? null,
          brokerId,
          factoryId,
          sourceCandidateId: source.id,
          applicantGroupId: groupId,
          transferReason: reason,
          familyMembers: familyMembers.length
            ? { create: familyMembers.map(({ name, relationship, age, occupation }) => ({ name, relationship, age, occupation })) }
            : undefined,
        } as Prisma.CandidateUncheckedCreateInput,
        include: candidateInclude,
      });
      const snapshot = snapshotData ? { parsed: snapshotData, formType } : null;
      await this.upsertFormSnapshot(tx, candidate.id, snapshot);
      return this.withLegacyFormDataJson({ ...candidate, formSnapshot: snapshot ? this.snapshotRow(snapshot) : null });
    });
  }

  // Lịch sử ứng tuyển: mọi hồ sơ cùng chuỗi nhân bản (kể cả chính nó), cũ → mới.
  async listApplications(id: string) {
    const current = await this.prisma.candidate.findUnique({ where: { id, ...NOT_DELETED }, select: { id: true, applicantGroupId: true } });
    if (!current) throw new NotFoundException('Not found');
    if (!current.applicantGroupId) return [];
    const groupId = current.applicantGroupId;
    return this.prisma.candidate.findMany({
      where: { OR: [{ applicantGroupId: groupId }, { id: groupId }], ...NOT_DELETED },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        candidateCode: true,
        status: true,
        transferReason: true,
        sourceCandidateId: true,
        createdAt: true,
        broker: { select: { id: true, name: true } },
        factory: { select: { id: true, name: true } },
      },
    });
  }

  // Ảnh có đang dùng chung bởi >= 2 hồ sơ nhân bản không. Dùng để chặn /delete-image xoá ảnh của hồ sơ kia
  // (vd sửa hồ sơ ở nhà máy B, thay ảnh đại diện → không được xoá file mà hồ sơ ở nhà máy A vẫn dùng).
  // Chỉ quét hồ sơ có applicantGroupId (số ít) nên rẻ.
  async isImageShared(url?: string | null): Promise<boolean> {
    if (!url) return false;
    const rows = await this.prisma.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      SELECT COUNT(*) AS n
      FROM ${this.prisma.table('Candidate')} c
      LEFT JOIN ${this.prisma.table('CandidateFormSnapshot')} s ON s."candidateId" = c."id"
      WHERE c."applicantGroupId" IS NOT NULL
        AND (
          c."avatarUrl" = ${url} OR c."lineImageUrl" = ${url}
          OR ${url} = ANY(c."limbImages") OR ${url} = ANY(c."scarImages") OR ${url} = ANY(c."tattooImages")
          OR strpos(s."data"::text, ${url}) > 0
        )
    `);
    return Number(rows[0]?.n ?? 0) >= 2;
  }

  private reapplySnapshotData(
    data: Prisma.JsonValue | null | undefined,
    legacyJson: string | null,
    formType: string,
  ): Prisma.InputJsonValue | null {
    let raw: unknown = data ?? null;
    if (!raw && legacyJson) {
      try {
        raw = JSON.parse(legacyJson);
      } catch {
        raw = null;
      }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const copy = { ...(raw as Record<string, unknown>) };
    for (const key of REAPPLY_STRIP_SNAPSHOT_KEYS) delete copy[key];
    copy.formType = formType;
    return copy as Prisma.InputJsonValue;
  }

  // Bản nháp gắn với phiên của một TAB trình duyệt (sessionStorage) — mở ở tab khác là lệch phiên.
  // Cho nhập tiếp khi: đúng phiên, hoặc chính người tạo bản nháp, hoặc Admin / người có quyền kiểm duyệt
  // (tab "Hồ sơ nháp" liệt kê mọi bản nháp nên cần mở được từ tab/máy khác).
  private canContinueDraft(
    existing: { draftSessionId: string | null; createdByUserId: string | null },
    draftSessionId: string | null,
    user: AuthUser,
  ) {
    if (draftSessionId && existing.draftSessionId === draftSessionId) return true;
    if (existing.createdByUserId && existing.createdByUserId === user.id) return true;
    return user.role === 'ADMIN' || user.canModerate === true;
  }

  // Sau khi kiểm duyệt, hồ sơ bị khóa: chỉ Admin hoặc chính người đã kiểm duyệt mới được sửa.
  private assertCanEdit(existing: { isVerified: boolean | null; verifiedById: string | null }, user: AuthUser) {
    if (!existing.isVerified) return;
    if (user.role === 'ADMIN') return;
    if (existing.verifiedById && existing.verifiedById === user.id) return;
    throw new ForbiddenException('Ho so da kiem duyet - chi Admin hoac nguoi kiem duyet moi co the sua');
  }

  private computeNameSearch(data: Record<string, unknown>, fallbackName?: string | null) {
    const vn = this.stringValue(data.vietnameseName) ?? (fallbackName ? fallbackName : null);
    const cn = this.stringValue(data.chineseName);
    return buildCandidateNameSearch([vn, cn]) || null;
  }

  // Mọi hồ sơ (đã hoàn tất, chưa xoá) trùng họ tên + ngày sinh trên TOÀN hệ thống — không cần trùng SĐT/CCCD.
  // Tên so bằng personNameKey (bỏ qua hoa/thường, khoảng trắng, NFC/NFD, kiểu đặt dấu "Hoà"/"Hòa");
  // ngày sinh nhận mọi cách ghi của cùng một ngày (19/03/2006, 19/3/2006, 2006-03-19…).
  private async findNameDobMatches(name: string, dob: string, excludeId?: string) {
    const key = personNameKey(name);
    const dobs = dobVariants(dob);
    if (!key || !dobs.length) return [];
    const rows = await this.prisma.candidate.findMany({
      where: {
        dateOfBirth: { in: dobs },
        status: { not: 'DRAFT' },
        ...NOT_DELETED,
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        vietnameseName: true,
        address: true,
        candidateCode: true,
        brokerId: true,
        factoryId: true,
        applicantGroupId: true,
        broker: { select: { name: true } },
        factory: { select: { name: true } },
      },
    });
    return rows.filter((r) => personNameKey(r.vietnameseName) === key);
  }

  // Cùng nhà máy (hoặc cùng môi giới khi không có nhà máy) → trùng bị CHẶN lưu. Khác nhà máy chỉ cảnh báo,
  // để một người trượt nhà máy A vẫn nộp được nhà máy B. Không có scope → coi như toàn hệ thống.
  private inDupScope(row: { brokerId: string | null; factoryId: string | null }, scope?: DupScope) {
    if (scope?.factoryId) return row.factoryId === scope.factoryId;
    if (scope?.brokerId) return row.brokerId === scope.brokerId && !row.factoryId;
    return true;
  }

  // Chặn lưu khi trùng họ tên + ngày sinh trong cùng nhà máy. Gọi ở create/update/complete/reapply/restore (không dùng cho draft).
  private async assertNoTripleDuplicate(data: Record<string, unknown>, excludeId?: string, scope?: DupScope) {
    const matches = await this.findNameDobMatches(
      this.stringValue(data.vietnameseName) ?? '',
      this.stringValue(data.dateOfBirth) ?? '',
      excludeId,
    );
    const match = matches.find((r) => this.inDupScope(r, scope));
    if (match) {
      const code = match.candidateCode ? ` (ma ${match.candidateCode})` : '';
      throw new ConflictException(`Da ton tai ho so trung Ho ten + Ngay sinh trong cung nha may${code}`);
    }
  }

  private dupScope(data: Record<string, unknown>, existing: { brokerId: string | null; factoryId: string | null }): DupScope {
    return {
      brokerId: this.stringValue(data.brokerId) ?? existing.brokerId,
      factoryId: this.stringValue(data.factoryId) ?? existing.factoryId,
    };
  }

  // Cảnh báo FE trước khi lưu: mọi hồ sơ trùng họ tên + ngày sinh ở BẤT KỲ nhà máy nào.
  // blocking = có hồ sơ trùng cùng nhà máy (bấm Lưu sẽ bị chặn); còn lại chỉ là cảnh báo.
  // Hồ sơ cùng chuỗi chuyển hồ sơ (applicantGroupId) là cùng một người đã được chuyển → không báo.
  async checkDuplicateProfile(name?: string, dob?: string, excludeId?: string, scope?: DupScope, applicantGroupId?: string) {
    const all = await this.findNameDobMatches(name ?? '', dob ?? '', excludeId);
    const matches = all
      .filter((r) => !applicantGroupId || (r.applicantGroupId !== applicantGroupId && r.id !== applicantGroupId))
      .map((r) => ({ ...r, blocking: this.inDupScope(r, scope) }))
      .sort((a, b) => Number(b.blocking) - Number(a.blocking));
    const blocking = matches.some((r) => r.blocking);
    return { duplicate: matches.length > 0, blocking, match: matches[0] ?? null, matches: matches.slice(0, 5) };
  }

  async checkCccd(cccd?: string, phone?: string, excludeId?: string) {
    const normalizedCccd = cccd?.trim();
    const normalizedPhone = phone?.trim();
    const phoneDigits = normalizedPhone?.replace(/\D/g, '') ?? '';

    const or: Prisma.CandidateWhereInput[] = [];
    if (normalizedCccd && normalizedCccd.length >= 9) or.push({ cccd: normalizedCccd });
    if (normalizedPhone && phoneDigits.length >= 9) or.push({ phone: normalizedPhone });
    if (or.length === 0) return { duplicates: [] };

    const duplicates = await this.prisma.candidate.findMany({
      where: { OR: or, ...NOT_DELETED, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
      select: {
        id: true,
        vietnameseName: true,
        candidateCode: true,
        dateOfBirth: true,
        cccd: true,
        phone: true,
        broker: { select: { name: true } },
        factory: { select: { name: true } },
        // FE dùng để nhận ra hồ sơ cùng chuỗi chuyển hồ sơ (hồ sơ gốc) — không coi là trùng.
        applicantGroupId: true,
        createdAt: true,
      },
      take: 5,
    });
    return { duplicates };
  }

  private async validateBrokerFactory(brokerId?: string | null, factoryId?: string | null, requireFactory = false) {
    if (!brokerId) throw new BadRequestException('Thieu cong ty moi gioi (brokerId)');
    const [broker, factory] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: brokerId }, include: { _count: { select: { factories: true } } } }),
      factoryId ? this.prisma.company.findUnique({ where: { id: factoryId } }) : null,
    ]);
    if (!broker || broker.type !== 'BROKER') throw new BadRequestException('Cong ty moi gioi khong hop le');
    if (factoryId && (!factory || factory.type !== 'FACTORY')) throw new BadRequestException('Nha may khong hop le');
    if (factoryId && factory?.brokerCompanyId !== brokerId) throw new BadRequestException('Nha may khong thuoc cong ty moi gioi da chon');
    if ((requireFactory || broker._count.factories > 0) && !factoryId) throw new BadRequestException('Thieu nha may (factoryId)');
  }

  private async validateRequestedTeam(input?: string) {
    const code = normalizeTeamCode(input);
    if (!code) return;
    const formatError = validateTeamCodeFormat(code);
    if (formatError) throw new BadRequestException(formatError);
    const row = await this.prisma.teamCode.findUnique({ where: { code } });
    if (!row || !row.isActive) throw new BadRequestException('Team Code khong hop le hoac da tat');
  }

  private async resolveTeamForCode(rawTeamCode: unknown, user: AuthUser) {
    const requestedTeam = normalizeTeamCode(rawTeamCode);
    if (requestedTeam) return requestedTeam;
    if (user.teamCode) return user.teamCode;
    const row = await this.prisma.user.findUnique({ where: { id: user.id }, select: { teamCode: true } });
    return row?.teamCode ?? null;
  }

  /**
   * Tổ suy từ tiền tố mã hồ sơ (candidateCode = TEAM + số, vd "KSV07" → "KSV").
   * Mã bất biến sau khi cấp nên là nguồn sự thật của tổ: khi hồ sơ ĐÃ có mã, cột
   * teamCode phải bám theo tiền tố này, tránh bị ghi đè theo tổ của người sửa
   * (nguyên nhân card "Số hồ sơ theo tổ" đếm dồn hết vào tổ của người sửa).
   */
  private teamPrefixFromCode(code: string | null | undefined): string | null {
    const prefix = typeof code === 'string' ? code.trim().replace(/\d+$/, '').replace(/-+$/, '') : '';
    return prefix ? normalizeTeamCode(prefix) : null;
  }

  private cleanCandidatePayload(body: Record<string, unknown>) {
    const {
      familyMembers,
      skills: _skills,
      interviewResult: _interviewResult,
      teamCode,
      complete: _complete,
      isDraft: _isDraft,
      // Cờ kiểm duyệt chỉ được đổi qua endpoint verify, không nhận từ payload thường.
      isVerified: _isVerified,
      verifiedById: _verifiedById,
      verifiedByName: _verifiedByName,
      verifiedAt: _verifiedAt,
      nameSearch: _nameSearch,
      // Mã hồ sơ do BE cấp (bộ đếm toàn cục) và bất biến sau khi cấp — bỏ mã trình duyệt gửi lên để
      // không ai lưu được mã tự đặt / trùng mã người khác. Hồ sơ đã có mã thì giữ nguyên mã cũ.
      candidateCode: _clientCandidateCode,
      // Liên kết chuyển hồ sơ chỉ đặt qua POST /candidates/:id/reapply (transferReason thì sửa được qua form).
      sourceCandidateId: _sourceCandidateId,
      applicantGroupId: _applicantGroupId,
      source: _source,
      transfers: _transfers,
      ...data
    } = body;
    return {
      familyMembers: Array.isArray(familyMembers) ? (familyMembers as Prisma.FamilyMemberCreateWithoutCandidateInput[]) : [],
      teamCode: typeof teamCode === 'string' ? teamCode : undefined,
      data: data as Record<string, unknown>,
    };
  }

  private stringValue(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private takeFormSnapshot(data: Record<string, unknown>) {
    const raw = this.stringValue(data.formDataJson);
    delete data.formDataJson;
    if (!raw) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BadRequestException('formDataJson khong phai JSON hop le');
    }

    const normalized = this.forms.normalizeSnapshot(parsed, {
      company: this.stringValue(data.company),
    });
    return { raw, parsed: normalized.data, formType: normalized.formType };
  }

  // Chặn ảnh base64 lọt vào DB: đẩy lên Cloudinary rồi thay bằng URL, cho CẢ cột candidate
  // (avatarUrl/lineImageUrl/…) lẫn snapshot JSON. Cache chung để ảnh xuất hiện ở cả hai chỉ upload 1 lần.
  // Upload lỗi thì giữ nguyên base64 (không làm hỏng thao tác lưu hồ sơ khi Cloudinary gặp sự cố).
  private async sanitizeWriteImages<S extends { parsed: Prisma.InputJsonValue } | null>(
    data: Record<string, unknown> | null,
    snapshot: S,
    candidateId = 'temp',
  ): Promise<S> {
    if (!this.uploads.isConfigured()) return snapshot;
    const cache = new Map<string, string>();
    const upload = async (uri: string) => {
      try {
        return await this.uploads.uploadDataUri(uri, { type: 'legacy', candidateId });
      } catch {
        return uri; // giữ base64 thay vì để lưu hồ sơ thất bại
      }
    };
    if (data) {
      for (const [key, value] of Object.entries(data)) {
        data[key] = await sanitizeImageValues(value, upload, cache);
      }
    }
    if (!snapshot) return snapshot;
    const parsed = (await sanitizeImageValues(snapshot.parsed, upload, cache)) as Prisma.InputJsonValue;
    return { ...snapshot, parsed };
  }

  private async upsertFormSnapshot(
    tx: Prisma.TransactionClient,
    candidateId: string,
    snapshot: { parsed: Prisma.InputJsonValue; formType: string | null } | null,
  ) {
    if (!snapshot) return;
    await tx.candidateFormSnapshot.upsert({
      where: { candidateId },
      create: {
        candidateId,
        formType: snapshot.formType,
        data: snapshot.parsed,
      },
      update: {
        formType: snapshot.formType,
        data: snapshot.parsed,
      },
    });
  }

  private snapshotRow(snapshot: { parsed: Prisma.InputJsonValue; formType: string | null }) {
    return {
      id: '',
      candidateId: '',
      formType: snapshot.formType,
      data: snapshot.parsed as Prisma.JsonValue,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private snapshotString(data: Prisma.JsonValue | null | undefined) {
    if (data === null || data === undefined) return null;
    return JSON.stringify(data);
  }

  private withLegacyFormDataJson<T extends { formDataJson?: string | null; formSnapshot?: { data: Prisma.JsonValue } | null }>(candidate: T) {
    const snapshot = this.snapshotString(candidate.formSnapshot?.data);
    const { formSnapshot: _formSnapshot, ...rest } = candidate;
    return { ...rest, formDataJson: snapshot ?? candidate.formDataJson ?? null };
  }

  private compactListFormData(formDataJson: string | null) {
    if (!formDataJson) return null;

    try {
      const parsed = JSON.parse(formDataJson) as Record<string, unknown>;
      const compact = {
        mathScore: parsed.mathScore,
        beanCount: parsed.beanCount,
        lensCheck: parsed.lensCheck,
        shiftChoice: parsed.shiftChoice,
      };

      return Object.values(compact).some((value) => value !== undefined && value !== null && String(value).trim())
        ? JSON.stringify(compact)
        : null;
    } catch {
      return null;
    }
  }

  private isCandidateListRequest(query: Record<string, unknown>) {
    return ['trash', 'page','pageSize', 'search', 'gender', 'education', 'brokerId', 'factoryId', 'fromDate', 'toDate', 'sortBy', 'status', 'draftSessionId', 'isVerified', 'candidateCode'].some(
      (key) => query[key] !== undefined,
    );
  }

  private async buildWhere(query: Record<string, unknown>): Promise<Prisma.CandidateWhereInput> {
    // trash=1 → chỉ hồ sơ đã xoá mềm (Thùng rác); còn lại luôn loại hồ sơ đã xoá.
    const and: Prisma.CandidateWhereInput[] = [query.trash === '1' ? { deletedAt: { not: null } } : NOT_DELETED];
    const search = String(query.search ?? '').trim();
    if (query.status === 'DRAFT' || query.status === 'COMPLETED') and.push({ status: query.status });
    if (query.draftSessionId) and.push({ draftSessionId: String(query.draftSessionId) });
    if (search) {
      const normalized = normalizeSearch(search);
      and.push({
        OR: [
          // Tìm theo tên không dấu / không phân biệt hoa-thường qua cột nameSearch đã chuẩn hóa.
          ...(normalized ? [{ nameSearch: { contains: normalized } }] : []),
          { vietnameseName: { contains: search, mode: 'insensitive' as const } },
          { chineseName: { contains: search, mode: 'insensitive' as const } },
          { candidateCode: { contains: search, mode: 'insensitive' as const } },
          { address: { contains: search, mode: 'insensitive' as const } },
          { company: { contains: search, mode: 'insensitive' as const } },
          { broker: { name: { contains: search, mode: 'insensitive' as const } } },
          { factory: { name: { contains: search, mode: 'insensitive' as const } } },
        ],
      });
    }
    // Lọc mã số hồ sơ: cho nhập nhiều mã cách nhau bởi dấu phẩy / khoảng trắng (khớp một phần, không phân biệt hoa-thường).
    const codes = String(query.candidateCode ?? '').split(/[\s,;]+/).filter(Boolean);
    if (codes.length) {
      and.push({ OR: codes.map((code) => ({ candidateCode: { contains: code, mode: 'insensitive' as const } })) });
    }
    if (query.gender) and.push({ gender: String(query.gender) });
    if (query.education) and.push({ education: String(query.education) });
    if (query.brokerId) and.push({ brokerId: String(query.brokerId) });
    if (query.factoryId) and.push({ factoryId: String(query.factoryId) });
    if (query.isVerified === 'true') and.push({ isVerified: true });
    else if (query.isVerified === 'false') and.push({ OR: [{ isVerified: false }, { isVerified: null }] });
    if (query.fromDate || query.toDate) {
      const createdAt: Prisma.DateTimeFilter = {};
      if (query.fromDate) createdAt.gte = new Date(String(query.fromDate));
      if (query.toDate) createdAt.lte = new Date(`${String(query.toDate)}T23:59:59.999`);
      and.push({ createdAt });
    }
    return and.length ? { AND: and } : {};
  }

  private buildOrderBy(sortBy: string): Prisma.CandidateOrderByWithRelationInput[] {
    if (sortBy === 'oldest') return [{ createdAt: 'asc' }];
    if (sortBy === 'name') return [{ vietnameseName: 'asc' }];
    return [{ createdAt: 'desc' }];
  }

  private async getFilterOptions(): Promise<CandidateFilterOptions> {
    const now = Date.now();
    if (this.filterOptionsCache && this.filterOptionsCache.expires > now) {
      return this.filterOptionsCache.value;
    }

    const [educationRows, brokers] = await Promise.all([
      this.prisma.candidate.findMany({
        where: { education: { not: null }, ...NOT_DELETED },
        distinct: ['education'],
        select: { education: true },
        orderBy: { education: 'asc' },
      }),
      this.prisma.company.findMany({
        where: { type: 'BROKER' },
        select: { id: true, name: true, chineseName: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    const value: CandidateFilterOptions = {
      educations: educationRows.map((r) => r.education).filter((v): v is string => Boolean(v)),
      brokers,
    };
    this.filterOptionsCache = { value, expires: now + FILTER_OPTIONS_TTL_MS };
    return value;
  }

  private async getStats() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    // Gộp totalAll + maleCount + femaleCount vào MỘT groupBy thay vì 3 count riêng → ít round-trip tới DB.
    // draftCount cho nhãn tab "Hồ sơ nháp (N)" — gộp vào đây (chạy song song) thay vì FE gọi riêng một request list.
    const [genderGroups, recentCount, draftCount, filterOptions] = await Promise.all([
      this.prisma.candidate.groupBy({ by: ['gender'], where: NOT_DELETED, _count: { _all: true } }),
      this.prisma.candidate.count({ where: { createdAt: { gte: sevenDaysAgo }, ...NOT_DELETED } }),
      this.prisma.candidate.count({ where: { status: 'DRAFT', ...NOT_DELETED } }),
      this.getFilterOptions(),
    ]);

    let totalAll = 0;
    let maleCount = 0;
    let femaleCount = 0;
    for (const group of genderGroups) {
      const n = group._count._all;
      totalAll += n;
      if (group.gender === 'Nam') maleCount += n;
      else if (group.gender === 'Nữ' || group.gender === 'Nu') femaleCount += n;
    }

    return { totalAll, maleCount, femaleCount, recentCount, draftCount, filterOptions };
  }
}
