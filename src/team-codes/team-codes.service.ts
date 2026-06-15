import { BadRequestException, Injectable } from '@nestjs/common';
import { normalizeTeamCode, validateTeamCodeFormat } from '../common/utils/team-code';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTeamCodeDto, UpdateTeamCodeDto } from './dto';

@Injectable()
export class TeamCodesService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    return { data: await this.prisma.teamCode.findMany({ orderBy: { code: 'asc' } }) };
  }

  async create(dto: CreateTeamCodeDto) {
    const code = this.validateCode(dto.code);
    const existing = await this.prisma.teamCode.findUnique({ where: { code } });
    if (existing) throw new BadRequestException('Team Code da ton tai');
    return this.prisma.teamCode.create({ data: { code, label: dto.label?.trim() || null } });
  }

  async update(id: string, dto: UpdateTeamCodeDto) {
    const data: { code?: string; label?: string | null; isActive?: boolean } = {};
    if (dto.code !== undefined) data.code = this.validateCode(dto.code);
    if (dto.label !== undefined) data.label = dto.label.trim() || null;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    try {
      return await this.prisma.teamCode.update({ where: { id }, data });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
        throw new BadRequestException('Team Code da ton tai');
      }
      throw error;
    }
  }

  async remove(id: string) {
    await this.prisma.teamCode.delete({ where: { id } });
    return { success: true };
  }

  private validateCode(input: unknown) {
    const code = normalizeTeamCode(input);
    const error = validateTeamCodeFormat(code);
    if (error) throw new BadRequestException(error);
    return code;
  }
}
