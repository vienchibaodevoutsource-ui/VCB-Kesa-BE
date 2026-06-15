import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Role, RegistrationStatus } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { RegistrationsService } from './registrations.service';

@Controller('registrations')
export class RegistrationsController {
  constructor(private readonly registrations: RegistrationsService) {}

  @Post()
  async create(@Body() body: Record<string, unknown>) {
    return { data: await this.registrations.create(body) };
  }

  @Get()
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  list(@Query('status') status?: string) {
    return this.registrations.list(status);
  }

  @Patch(':id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  async update(@Param('id') id: string, @Body('status') status: RegistrationStatus) {
    return { data: await this.registrations.updateStatus(id, status) };
  }

  @Delete(':id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  async remove(@Param('id') id: string) {
    return { data: await this.registrations.remove(id) };
  }
}
