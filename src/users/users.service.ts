import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { AuthUser } from '../common/types';
import { clampPage, isPaginatedListRequest, parsePaginationParams } from '../common/utils/pagination';
import { normalizeTeamCode, validateTeamCodeFormat } from '../common/utils/team-code';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto, UpdateUserDto } from './dto';

const userSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  isActive: true,
  createdAt: true,
  teamCode: true,
} as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: Record<string, unknown>) {
    if (!isPaginatedListRequest(query)) {
      return { data: await this.prisma.user.findMany({ orderBy: { createdAt: 'desc' }, select: userSelect }) };
    }

    const role = String(query.role ?? '');
    const { page, pageSize, search } = parsePaginationParams(query);
    const where: Prisma.UserWhereInput = {};
    if (role === 'ADMIN' || role === 'MEMBER') where.role = role as Role;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
        { teamCode: { contains: search, mode: 'insensitive' } },
      ];
    }

    const total = await this.prisma.user.count({ where });
    const { page: safePage } = clampPage(page, total, pageSize);
    const skip = (safePage - 1) * pageSize;
    const [data, totalUsers, adminCount, memberCount, activeCount] = await Promise.all([
      this.prisma.user.findMany({ where, orderBy: { createdAt: 'desc' }, select: userSelect, skip, take: pageSize }),
      this.prisma.user.count(),
      this.prisma.user.count({ where: { role: 'ADMIN' } }),
      this.prisma.user.count({ where: { role: 'MEMBER' } }),
      this.prisma.user.count({ where: { isActive: true } }),
    ]);

    return { data, total, page: safePage, pageSize, stats: { totalUsers, adminCount, memberCount, activeCount } };
  }

  async create(dto: CreateUserDto) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('Email da ton tai');
    const teamCode = await this.validateTeamCode(dto.teamCode);
    return this.prisma.user.create({
      data: {
        name: dto.name,
        email: dto.email,
        password: await bcrypt.hash(dto.password, 10),
        phone: dto.phone || null,
        role: dto.role || 'MEMBER',
        teamCode,
      },
      select: userSelect,
    });
  }

  async update(id: string, dto: UpdateUserDto, currentUser: AuthUser) {
    const target = await this.prisma.user.findUnique({ where: { id }, select: { role: true } });
    if (dto.role !== undefined && (id === currentUser.id || target?.role === 'ADMIN')) {
      throw new ForbiddenException('Khong the thay doi quyen han cua tai khoan admin hoac chinh minh');
    }

    const data: Prisma.UserUncheckedUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.phone !== undefined) data.phone = dto.phone || null;
    if (dto.role !== undefined) data.role = dto.role;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.teamCode !== undefined) data.teamCode = await this.validateTeamCode(dto.teamCode);
    if (dto.password) data.password = await bcrypt.hash(dto.password, 10);

    try {
      return await this.prisma.user.update({ where: { id }, data, select: userSelect });
    } catch (error) {
      if (this.isUniqueError(error)) throw new ConflictException('Email da ton tai');
      throw error;
    }
  }

  async remove(id: string) {
    await this.prisma.user.delete({ where: { id } });
    return { success: true };
  }

  private async validateTeamCode(input?: string) {
    const code = normalizeTeamCode(input);
    if (!code) return null;
    const formatError = validateTeamCodeFormat(code);
    if (formatError) throw new BadRequestException(formatError);
    const row = await this.prisma.teamCode.findUnique({ where: { code } });
    if (!row) throw new BadRequestException('Team Code khong ton tai trong danh sach');
    return code;
  }

  private isUniqueError(error: unknown) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
  }
}
