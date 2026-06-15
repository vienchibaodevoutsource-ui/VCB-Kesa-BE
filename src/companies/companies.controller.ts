import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CompaniesService } from './companies.service';
import { SaveCompanyDto } from './dto';

@Controller('companies')
@UseGuards(AuthGuard, RolesGuard)
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.companies.list(query);
  }

  @Post()
  @Roles(Role.ADMIN)
  async create(@Body() dto: SaveCompanyDto) {
    return { data: await this.companies.create(dto) };
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  async update(@Param('id') id: string, @Body() dto: SaveCompanyDto) {
    return { data: await this.companies.update(id, dto) };
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  async remove(@Param('id') id: string) {
    return { data: await this.companies.remove(id) };
  }
}
