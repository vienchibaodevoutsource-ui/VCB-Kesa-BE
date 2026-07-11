import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CandidateStatus, Prisma } from '@prisma/client';
import { CandidateCodesService } from '../candidate-codes/candidate-codes.service';
import { AuthUser } from '../common/types';
import { clampPage } from '../common/utils/pagination';
import { buildCandidateNameSearch, normalizeSearch } from '../common/utils/normalize';
import { normalizeTeamCode, validateTeamCodeFormat } from '../common/utils/team-code';
import { FormsService } from '../forms/forms.service';
import { PrismaService } from '../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import { sanitizeImageValues } from '../common/utils/image-sanitizer';

const candidateInclude = {
  familyMembers: true,
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
  lineImageUrl: true,
  domesticExperience: true,
  overseasExperience: true,
  note: true,
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

// Candidate writes embed base64 images (payload up to ~25MB), so the candidate
// create/update + form-snapshot upsert can exceed Prisma's default 5s interactive
// transaction limit. Give the write transaction more room to finish.
const CANDIDATE_TX_OPTIONS = { maxWait: 15_000, timeout: 30_000 } as const;

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

  async list(query: Record<string, unknown>) {
    if (query.statsOnly === '1') {
      return { stats: await this.getStats() };
    }

    if (!this.isCandidateListRequest(query)) {
      return {
        data: await this.prisma.candidate.findMany({
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
    const orderBy = this.buildOrderBy(sortBy);
    const total = await this.prisma.candidate.count({ where });
    const { page: safePage } = clampPage(page, total, pageSize);
    const skip = (safePage - 1) * pageSize;

    const includeStats = query.stats !== '0';
    const [data, stats] = await Promise.all([
      this.prisma.candidate.findMany({ where, orderBy, skip, take: pageSize, select: candidateListSelect }),
      includeStats ? this.getStats() : Promise.resolve(null),
    ]);

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
        FROM "CandidateFormSnapshot"
        WHERE "candidateId" IN (${Prisma.join(ids)})
      `);
      for (const row of snapRows) {
        if (row.id) result.set(row.id, buildCompact(row));
      }
    } catch {
      // Nếu truy vấn trích JSON lỗi, bỏ qua 4 field phụ — danh sách vẫn hiển thị bình thường.
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
    const candidate = await this.prisma.candidate.findUnique({ where: { id }, include: candidateInclude });
    if (!candidate) throw new NotFoundException('Not found');
    return this.withLegacyFormDataJson(candidate);
  }

  async create(body: Record<string, unknown>, user: AuthUser) {
    const { familyMembers, teamCode, data } = this.cleanCandidatePayload(body);
    const formSnapshot = await this.sanitizeWriteImages(data, this.takeFormSnapshot(data));
    const brokerId = this.stringValue(data.brokerId);
    const factoryId = this.stringValue(data.factoryId);
    await this.validateBrokerFactory(brokerId, factoryId);
    await this.assertNoTripleDuplicate(data);
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
            candidateCode: candidateCode ?? this.stringValue(data.candidateCode) ?? null,
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

    if (!data.candidateCode) {
      if (resolvedTeamCode) return this.codes.withUniqueCandidateCode(resolvedTeamCode, buildCreate);
    }
    return buildCreate();
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
    const existing = await this.prisma.candidate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Not found');
    if (existing.status !== 'DRAFT') throw new BadRequestException('Chi co the autosave ho so draft');

    const draftSessionId = this.stringValue(body.draftSessionId);
    if (!draftSessionId || existing.draftSessionId !== draftSessionId) {
      throw new ForbiddenException('Khong co quyen cap nhat ho so draft nay');
    }

    const { familyMembers, teamCode, data } = this.cleanCandidatePayload(body);
    const formSnapshot = await this.sanitizeWriteImages(data, this.takeFormSnapshot(data));
    delete data.status;
    delete data.draftSessionId;

    let generatedCode: string | undefined;
    await this.validateRequestedTeam(teamCode);
    const resolvedTeamCode = (await this.resolveTeamForCode(teamCode, user)) || existing.teamCode || null;

    if (!existing.candidateCode && !data.candidateCode) {
      if (resolvedTeamCode) generatedCode = await this.codes.generateCandidateCode(resolvedTeamCode);
    }

    await this.prisma.familyMember.deleteMany({ where: { candidateId: id } });
    return this.candidateTx(async (tx) => {
      const candidate = await tx.candidate.update({
        where: { id },
        data: {
          ...data,
          candidateCode: generatedCode ?? this.stringValue(data.candidateCode) ?? existing.candidateCode ?? null,
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
    const existing = await this.prisma.candidate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Not found');
    this.assertCanEdit(existing, user);
    const { familyMembers, teamCode, data } = this.cleanCandidatePayload(body);
    const formSnapshot = await this.sanitizeWriteImages(data, this.takeFormSnapshot(data));
    delete data.draftSessionId;
    await this.assertNoTripleDuplicate(data, id);
    await this.validateRequestedTeam(teamCode);
    const resolvedTeamCode = teamCode ? normalizeTeamCode(teamCode) : existing.teamCode;
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
    const existing = await this.prisma.candidate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Not found');
    this.assertCanEdit(existing, user);
    const draftSessionId = this.stringValue(body.draftSessionId);
    if (existing.status === 'DRAFT' && (!draftSessionId || existing.draftSessionId !== draftSessionId)) {
      throw new ForbiddenException('Khong co quyen hoan tat ho so draft nay');
    }

    const { familyMembers, teamCode, data } = this.cleanCandidatePayload(body);
    const formSnapshot = await this.sanitizeWriteImages(data, this.takeFormSnapshot(data));
    delete data.status;
    delete data.draftSessionId;
    if (!this.stringValue(data.vietnameseName) || data.vietnameseName === DRAFT_PLACEHOLDER_NAME) {
      throw new BadRequestException('Vui long nhap ho ten ung vien');
    }
    await this.assertNoTripleDuplicate(data, id);
    await this.validateRequestedTeam(teamCode);
    const resolvedTeamCode = (await this.resolveTeamForCode(teamCode, user)) || existing.teamCode || null;
    if (!resolvedTeamCode) throw new BadRequestException('Vui long chon ma to ho so (Team Code)');
    await this.prisma.familyMember.deleteMany({ where: { candidateId: id } });

    const buildUpdate = (candidateCode?: string) =>
      this.candidateTx(async (tx) => {
        const candidate = await tx.candidate.update({
          where: { id },
          data: {
            ...data,
            candidateCode: candidateCode ?? this.stringValue(data.candidateCode) ?? existing.candidateCode ?? null,
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

    if (!existing.candidateCode && !data.candidateCode) {
      if (resolvedTeamCode) return this.codes.withUniqueCandidateCode(resolvedTeamCode, buildUpdate);
    }
    return buildUpdate();
  }

  async remove(id: string) {
    await this.prisma.candidate.delete({ where: { id } });
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

    const existing = await this.prisma.candidate.findUnique({ where: { id }, select: { id: true } });
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

  // Chuẩn hoá để so trùng: bỏ hoa/thường + gộp khoảng trắng, GIỮ dấu tiếng Việt.
  private normName(value: unknown) {
    return this.stringValue(value)?.trim().replace(/\s+/g, ' ').toLowerCase() ?? '';
  }

  // Tìm hồ sơ (đã hoàn tất) trùng cả 3: họ tên + ngày sinh + quê quán (address).
  private async findTripleDuplicate(name: string, dob: string, hometown: string, excludeId?: string) {
    const dobTrim = dob.trim();
    if (!name.trim() || !dobTrim || !hometown.trim()) return null;
    const rows = await this.prisma.candidate.findMany({
      where: {
        dateOfBirth: dobTrim,
        status: { not: 'DRAFT' },
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
      select: { id: true, vietnameseName: true, address: true, candidateCode: true },
    });
    const n = this.normName(name);
    const h = this.normName(hometown);
    return rows.find((r) => this.normName(r.vietnameseName) === n && this.normName(r.address) === h) ?? null;
  }

  // Chặn lưu khi trùng cả 3 trường. Gọi ở create/update/complete (không dùng cho draft).
  private async assertNoTripleDuplicate(data: Record<string, unknown>, excludeId?: string) {
    const match = await this.findTripleDuplicate(
      this.stringValue(data.vietnameseName) ?? '',
      this.stringValue(data.dateOfBirth) ?? '',
      this.stringValue(data.address) ?? '',
      excludeId,
    );
    if (match) {
      const code = match.candidateCode ? ` (ma ${match.candidateCode})` : '';
      throw new ConflictException(`Da ton tai ho so trung Ho ten + Ngay sinh + Que quan${code}`);
    }
  }

  // Cảnh báo FE: trả về hồ sơ trùng cả 3 (nếu có) để hiển thị trước khi lưu.
  async checkDuplicateProfile(name?: string, dob?: string, hometown?: string, excludeId?: string) {
    const match = await this.findTripleDuplicate(name ?? '', dob ?? '', hometown ?? '', excludeId);
    return { duplicate: !!match, match: match ?? null };
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
      where: { OR: or, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
      select: {
        id: true,
        vietnameseName: true,
        candidateCode: true,
        dateOfBirth: true,
        cccd: true,
        phone: true,
        broker: { select: { name: true } },
        factory: { select: { name: true } },
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

  // Chặn ảnh base64 lọt vào DB: đẩy lên Supabase Storage rồi thay bằng URL, cho CẢ cột candidate
  // (avatarUrl/lineImageUrl/…) lẫn snapshot JSON. Cache chung để ảnh xuất hiện ở cả hai chỉ upload 1 lần.
  // Upload lỗi thì giữ nguyên base64 (không làm hỏng thao tác lưu hồ sơ khi Storage gặp sự cố).
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
    return ['page', 'pageSize', 'search', 'gender', 'education', 'brokerId', 'factoryId', 'fromDate', 'toDate', 'sortBy', 'status', 'draftSessionId', 'isVerified'].some(
      (key) => query[key] !== undefined,
    );
  }

  private async buildWhere(query: Record<string, unknown>): Promise<Prisma.CandidateWhereInput> {
    const and: Prisma.CandidateWhereInput[] = [];
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
        where: { education: { not: null } },
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
    const [genderGroups, recentCount, filterOptions] = await Promise.all([
      this.prisma.candidate.groupBy({ by: ['gender'], _count: { _all: true } }),
      this.prisma.candidate.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
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

    return { totalAll, maleCount, femaleCount, recentCount, filterOptions };
  }
}
