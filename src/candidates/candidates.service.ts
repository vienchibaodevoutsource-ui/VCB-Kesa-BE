import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CandidateStatus, Prisma } from '@prisma/client';
import { CandidateCodesService } from '../candidate-codes/candidate-codes.service';
import { AuthUser } from '../common/types';
import { clampPage } from '../common/utils/pagination';
import { normalizeTeamCode, validateTeamCodeFormat } from '../common/utils/team-code';
import { PrismaService } from '../prisma/prisma.service';

const candidateInclude = { familyMembers: true, broker: true, factory: true, formSnapshot: true } as const;
const candidateListInclude = {
  broker: { select: { id: true, name: true, chineseName: true, slug: true } },
  factory: { select: { id: true, name: true, chineseName: true, slug: true } },
} as const;

const candidateListSelect = {
  id: true,
  candidateCode: true,
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
  createdAt: true,
  lastSavedAt: true,
  status: true,
  domesticExperience: true,
  overseasExperience: true,
  note: true,
  formDataJson: true,
  formSnapshot: { select: { data: true } },
} as const;
const DRAFT_PLACEHOLDER_NAME = '(Dang nhap)';

@Injectable()
export class CandidatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly codes: CandidateCodesService,
  ) {}

  async list(query: Record<string, unknown>) {
    if (query.statsOnly === '1') {
      return { stats: await this.getStats() };
    }

    if (!this.isCandidateListRequest(query)) {
      return {
        data: await this.prisma.candidate.findMany({
          orderBy: { createdAt: 'desc' },
          include: candidateInclude,
        }),
      };
    }

    const page = Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1);
    const pageSize = Math.min(5000, Math.max(1, Number.parseInt(String(query.pageSize ?? '10'), 10) || 10));
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

    return {
      data: data.map((candidate) => ({
        ...candidate,
        formDataJson: this.compactListFormData(this.snapshotString(candidate.formSnapshot?.data) ?? candidate.formDataJson),
      })),
      total,
      page: safePage,
      pageSize,
      ...(stats ? { stats } : {}),
    };
  }

  async get(id: string) {
    const candidate = await this.prisma.candidate.findUnique({ where: { id }, include: candidateInclude });
    if (!candidate) throw new NotFoundException('Not found');
    return this.withLegacyFormDataJson(candidate);
  }

  async create(body: Record<string, unknown>, user: AuthUser) {
    const { familyMembers, teamCode, data } = this.cleanCandidatePayload(body);
    const formSnapshot = this.takeFormSnapshot(data);
    const brokerId = this.stringValue(data.brokerId);
    const factoryId = this.stringValue(data.factoryId);
    await this.validateBrokerFactory(brokerId, factoryId);
    await this.validateRequestedTeam(teamCode);

    const buildCreate = (candidateCode?: string) =>
      this.prisma.$transaction(async (tx) => {
        const candidate = await tx.candidate.create({
          data: {
            ...data,
            factoryId,
            candidateCode: candidateCode ?? this.stringValue(data.candidateCode) ?? null,
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
      const teamForCode = (await this.resolveTeamForCode(teamCode, user)) || null;
      if (teamForCode) return this.codes.withUniqueCandidateCode(teamForCode, buildCreate);
    }
    return buildCreate();
  }

  async createDraft(body: Record<string, unknown>, user: AuthUser) {
    const formSnapshot = this.takeFormSnapshot(body);
    const draftSessionId = this.stringValue(body.draftSessionId);
    const brokerId = this.stringValue(body.brokerId);
    const factoryId = this.stringValue(body.factoryId);
    if (!draftSessionId) throw new BadRequestException('Thieu draftSessionId');
    if (!brokerId || !factoryId) throw new BadRequestException('Thieu brokerId hoac factoryId');
    await this.validateBrokerFactory(brokerId, factoryId, true);
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.candidate.create({
        data: {
          status: 'DRAFT',
          draftSessionId,
          createdByUserId: user.id,
          lastSavedAt: new Date(),
          vietnameseName: this.stringValue(body.vietnameseName) || DRAFT_PLACEHOLDER_NAME,
          gender: this.stringValue(body.gender) || 'Nam',
          company: this.stringValue(body.company),
          candidateCode: null,
          broker: { connect: { id: brokerId } },
          factory: { connect: { id: factoryId } },
        },
        include: candidateInclude,
      });
      await this.upsertFormSnapshot(tx, candidate.id, formSnapshot);
      return this.withLegacyFormDataJson({ ...candidate, formSnapshot: formSnapshot ? this.snapshotRow(formSnapshot) : candidate.formSnapshot });
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
    const formSnapshot = this.takeFormSnapshot(data);
    delete data.status;
    delete data.draftSessionId;

    let generatedCode: string | undefined;
    if (!existing.candidateCode && !data.candidateCode) {
      const teamForCode = await this.resolveTeamForCode(teamCode, user);
      if (teamForCode) generatedCode = await this.codes.generateCandidateCode(teamForCode);
    }

    await this.prisma.familyMember.deleteMany({ where: { candidateId: id } });
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.candidate.update({
        where: { id },
        data: {
          ...data,
          candidateCode: generatedCode ?? this.stringValue(data.candidateCode) ?? existing.candidateCode ?? null,
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

  async update(id: string, body: Record<string, unknown>) {
    const existing = await this.prisma.candidate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Not found');
    const { familyMembers, data } = this.cleanCandidatePayload(body);
    const formSnapshot = this.takeFormSnapshot(data);
    delete data.draftSessionId;
    await this.prisma.familyMember.deleteMany({ where: { candidateId: id } });
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.candidate.update({
        where: { id },
        data: {
          ...data,
          status: (data.status as CandidateStatus | undefined) ?? 'COMPLETED',
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
    const draftSessionId = this.stringValue(body.draftSessionId);
    if (existing.status === 'DRAFT' && (!draftSessionId || existing.draftSessionId !== draftSessionId)) {
      throw new ForbiddenException('Khong co quyen hoan tat ho so draft nay');
    }

    const { familyMembers, teamCode, data } = this.cleanCandidatePayload(body);
    const formSnapshot = this.takeFormSnapshot(data);
    delete data.status;
    delete data.draftSessionId;
    if (!this.stringValue(data.vietnameseName) || data.vietnameseName === DRAFT_PLACEHOLDER_NAME) {
      throw new BadRequestException('Vui long nhap ho ten ung vien');
    }
    await this.validateRequestedTeam(teamCode);
    await this.prisma.familyMember.deleteMany({ where: { candidateId: id } });

    const buildUpdate = (candidateCode?: string) =>
      this.prisma.$transaction(async (tx) => {
        const candidate = await tx.candidate.update({
          where: { id },
          data: {
            ...data,
            candidateCode: candidateCode ?? this.stringValue(data.candidateCode) ?? existing.candidateCode ?? null,
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
      const teamForCode = await this.resolveTeamForCode(teamCode, user);
      if (teamForCode) return this.codes.withUniqueCandidateCode(teamForCode, buildUpdate);
    }
    return buildUpdate();
  }

  async remove(id: string) {
    await this.prisma.candidate.delete({ where: { id } });
    return { success: true };
  }

  async checkCccd(cccd?: string, excludeId?: string) {
    const normalized = cccd?.trim();
    if (!normalized || normalized.length < 9) return { duplicates: [] };
    const duplicates = await this.prisma.candidate.findMany({
      where: { cccd: normalized, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
      select: {
        id: true,
        vietnameseName: true,
        candidateCode: true,
        dateOfBirth: true,
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
    const { familyMembers, skills: _skills, interviewResult: _interviewResult, teamCode, complete: _complete, isDraft: _isDraft, ...data } = body;
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

    try {
      const parsed = JSON.parse(raw) as Prisma.InputJsonValue;
      const formType =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? this.stringValue((parsed as Record<string, unknown>).formType) ?? this.stringValue((parsed as Record<string, unknown>).company)
          : null;
      return { raw, parsed, formType };
    } catch {
      throw new BadRequestException('formDataJson khong phai JSON hop le');
    }
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
    return ['page', 'pageSize', 'search', 'gender', 'education', 'brokerId', 'factoryId', 'fromDate', 'toDate', 'sortBy', 'status', 'draftSessionId'].some(
      (key) => query[key] !== undefined,
    );
  }

  private async buildWhere(query: Record<string, unknown>): Promise<Prisma.CandidateWhereInput> {
    const and: Prisma.CandidateWhereInput[] = [];
    const search = String(query.search ?? '').trim();
    if (query.status === 'DRAFT' || query.status === 'COMPLETED') and.push({ status: query.status });
    if (query.draftSessionId) and.push({ draftSessionId: String(query.draftSessionId) });
    if (search) {
      and.push({
        OR: [
          { vietnameseName: { contains: search, mode: 'insensitive' } },
          { chineseName: { contains: search, mode: 'insensitive' } },
          { candidateCode: { contains: search, mode: 'insensitive' } },
          { address: { contains: search, mode: 'insensitive' } },
          { company: { contains: search, mode: 'insensitive' } },
          { broker: { name: { contains: search, mode: 'insensitive' } } },
          { factory: { name: { contains: search, mode: 'insensitive' } } },
        ],
      });
    }
    if (query.gender) and.push({ gender: String(query.gender) });
    if (query.education) and.push({ education: String(query.education) });
    if (query.brokerId) and.push({ brokerId: String(query.brokerId) });
    if (query.factoryId) and.push({ factoryId: String(query.factoryId) });
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

  private async getFilterOptions() {
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
    return { educations: educationRows.map((r) => r.education).filter(Boolean), brokers };
  }

  private async getStats() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [totalAll, maleCount, femaleCount, recentCount, filterOptions] = await Promise.all([
      this.prisma.candidate.count(),
      this.prisma.candidate.count({ where: { gender: 'Nam' } }),
      this.prisma.candidate.count({ where: { gender: { in: ['Nữ', 'Nu'] } } }),
      this.prisma.candidate.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      this.getFilterOptions(),
    ]);

    return { totalAll, maleCount, femaleCount, recentCount, filterOptions };
  }
}
