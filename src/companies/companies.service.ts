import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CompanyType, Prisma } from '@prisma/client';
import { clampPage, isPaginatedListRequest, parsePaginationParams } from '../common/utils/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { SaveCompanyDto } from './dto';

const companyInclude = {
  brokerCompany: {
    select: { id: true, name: true, chineseName: true, formType: true },
  },
} as const;

const companyLiteSelect = {
  id: true,
  name: true,
  chineseName: true,
  slug: true,
  isActive: true,
  brokerCompanyId: true,
  type: true,
  formType: true,
  color: true,
} as const;

@Injectable()
export class CompaniesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: Record<string, unknown>) {
    const type = String(query.type ?? '');
    const brokerCompanyId = typeof query.brokerCompanyId === 'string' ? query.brokerCompanyId : null;

    if (!isPaginatedListRequest(query)) {
      const where: Prisma.CompanyWhereInput = {};
      if (type === 'BROKER' || type === 'FACTORY') where.type = type as CompanyType;
      if (brokerCompanyId) where.brokerCompanyId = brokerCompanyId;
      return {
        data: await this.prisma.company.findMany({
          where,
          orderBy: [{ type: 'asc' }, { name: 'asc' }],
          ...(type === 'BROKER' ? { include: { _count: { select: { factories: true } } } } : {}),
        }),
      };
    }

    const { page, pageSize, search } = parsePaginationParams(query);
    const where = this.buildWhere(type, search, brokerCompanyId);
    const lite = query.fields === 'lite' || (type === 'FACTORY' && !!brokerCompanyId);
    const total = await this.prisma.company.count({ where });
    const { page: safePage } = clampPage(page, total, pageSize);
    const skip = (safePage - 1) * pageSize;

    if (lite) {
      const data = await this.prisma.company.findMany({
        where,
        orderBy: [{ type: 'asc' }, { name: 'asc' }],
        skip,
        take: pageSize,
        select: companyLiteSelect,
      });
      return { data, total, page: safePage, pageSize };
    }

    const [data, brokerCount, factoryCount, activeCount] = await Promise.all([
      this.prisma.company.findMany({
        where,
        orderBy: [{ type: 'asc' }, { name: 'asc' }],
        skip,
        take: pageSize,
        include: type === 'BROKER' ? { _count: { select: { factories: true } } } : companyInclude,
      }),
      query.includeStats === '1' ? this.prisma.company.count({ where: { type: 'BROKER' } }) : Promise.resolve(0),
      query.includeStats === '1' ? this.prisma.company.count({ where: { type: 'FACTORY' } }) : Promise.resolve(0),
      query.includeStats === '1' ? this.prisma.company.count({ where: { isActive: true } }) : Promise.resolve(0),
    ]);

    return {
      data,
      total,
      page: safePage,
      pageSize,
      ...(query.includeStats === '1' ? { stats: { brokerCount, factoryCount, activeCount } } : {}),
    };
  }

  async create(dto: SaveCompanyDto) {
    const data = await this.normalizeInput(dto);
    return this.prisma.company.create({ data, include: companyInclude });
  }

  async update(id: string, dto: SaveCompanyDto) {
    const existing = await this.prisma.company.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Khong tim thay cong ty');
    const data = await this.normalizeInput(
      { ...dto, type: dto.type || existing.type, slug: dto.slug || existing.slug },
      id,
    );
    return this.prisma.company.update({ where: { id }, data, include: companyInclude });
  }

  async remove(id: string) {
    const company = await this.prisma.company.findUnique({
      where: { id },
      include: { _count: { select: { brokerCandidates: true, factoryCandidates: true } } },
    });
    if (!company) throw new NotFoundException('Khong tim thay cong ty');
    const candidateCount = company._count.brokerCandidates + company._count.factoryCandidates;
    if (candidateCount > 0) {
      throw new ConflictException({
        error: `Khong the xoa: cong ty dang co ${candidateCount} ho so lien ket. Hay an cong ty thay vi xoa.`,
        details: { candidateCount },
      });
    }
    await this.prisma.company.delete({ where: { id } });
    return { success: true };
  }

  private buildWhere(type: string, search: string, brokerCompanyId: string | null): Prisma.CompanyWhereInput {
    const where: Prisma.CompanyWhereInput = {};
    if (type === 'BROKER' || type === 'FACTORY') where.type = type as CompanyType;
    if (brokerCompanyId) where.brokerCompanyId = brokerCompanyId;
    if (search) {
      const fields: Prisma.CompanyWhereInput[] = [
        { name: { contains: search, mode: 'insensitive' } },
        { chineseName: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
      ];
      if (!brokerCompanyId) {
        fields.push(
          { formType: { contains: search, mode: 'insensitive' } },
          { brokerCompany: { name: { contains: search, mode: 'insensitive' } } },
          { brokerCompany: { chineseName: { contains: search, mode: 'insensitive' } } },
        );
      }
      where.OR = fields;
    }
    return where;
  }

  private async normalizeInput(input: SaveCompanyDto, excludeId?: string): Promise<Prisma.CompanyUncheckedCreateInput> {
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('Thieu ten cong ty');
    const baseSlug = input.slug?.trim() || this.slugify(name);
    if (!baseSlug) throw new BadRequestException('Khong the tao slug tu ten cong ty');

    if (input.type === 'BROKER') {
      return {
        name,
        chineseName: input.chineseName || null,
        slug: await this.resolveUniqueSlug(baseSlug, excludeId),
        type: input.type,
        formType: input.formType || 'hoan-vu',
        color: input.color || null,
        isActive: input.isActive ?? true,
        brokerCompanyId: null,
      };
    }

    if (!input.brokerCompanyId) throw new BadRequestException('Vui long chon cong ty moi gioi cho nha may');
    const broker = await this.prisma.company.findUnique({ where: { id: input.brokerCompanyId } });
    if (!broker || broker.type !== 'BROKER') throw new BadRequestException('Cong ty moi gioi khong hop le');

    return {
      name,
      chineseName: input.chineseName || null,
      slug: await this.resolveUniqueSlug(baseSlug, excludeId),
      type: input.type,
      formType: broker.formType,
      color: input.color || null,
      isActive: input.isActive ?? true,
      brokerCompanyId: broker.id,
    };
  }

  private slugify(str: string) {
    return str
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  private async resolveUniqueSlug(baseSlug: string, excludeId?: string) {
    let slug = baseSlug;
    let suffix = 2;
    while (true) {
      const existing = await this.prisma.company.findFirst({
        where: { slug, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
      });
      if (!existing) return slug;
      slug = `${baseSlug}-${suffix++}`;
    }
  }
}
