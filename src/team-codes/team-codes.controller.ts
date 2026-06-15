import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreateTeamCodeDto, UpdateTeamCodeDto } from './dto';
import { TeamCodesService } from './team-codes.service';

@Controller('team-codes')
@UseGuards(AuthGuard, RolesGuard)
export class TeamCodesController {
  constructor(private readonly service: TeamCodesService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Post()
  @Roles(Role.ADMIN)
  async create(@Body() dto: CreateTeamCodeDto) {
    return { data: await this.service.create(dto) };
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  async update(@Param('id') id: string, @Body() dto: UpdateTeamCodeDto) {
    return { data: await this.service.update(id, dto) };
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  async remove(@Param('id') id: string) {
    return { data: await this.service.remove(id) };
  }
}
