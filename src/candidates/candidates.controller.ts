import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/types';
import { CandidatesService } from './candidates.service';

@Controller('candidates')
@UseGuards(AuthGuard)
export class CandidatesController {
  constructor(private readonly candidates: CandidatesService) {}

  @Get()
  list(@Query() query: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    return this.candidates.list(query, user);
  }

  @Post()
  async create(@Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    return { data: await this.candidates.create(body, user) };
  }

  @Post('draft')
  async createDraft(@Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    return { data: await this.candidates.createDraft(body, user) };
  }

  @Get('check-cccd')
  checkCccd(
    @Query('cccd') cccd?: string,
    @Query('phone') phone?: string,
    @Query('excludeId') excludeId?: string,
  ) {
    return this.candidates.checkCccd(cccd, phone, excludeId);
  }

  @Get('check-duplicate')
  checkDuplicate(
    @Query('name') name?: string,
    @Query('dob') dob?: string,
    @Query('hometown') hometown?: string,
    @Query('excludeId') excludeId?: string,
    @Query('brokerId') brokerId?: string,
    @Query('factoryId') factoryId?: string,
  ) {
    const scope = brokerId || factoryId ? { brokerId, factoryId } : undefined;
    return this.candidates.checkDuplicateProfile(name, dob, hometown, excludeId, scope);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return { data: await this.candidates.get(id) };
  }

  @Patch(':id')
  async autosave(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    return { data: await this.candidates.autosaveDraft(id, body, user) };
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    return { data: await this.candidates.update(id, body, user) };
  }

  @Patch(':id/verify')
  async verify(@Param('id') id: string, @Body() body: { verified?: boolean }, @CurrentUser() user: AuthUser) {
    return { data: await this.candidates.setVerified(id, body?.verified !== false, user) };
  }

  @Post(':id/reapply')
  async reapply(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    return { data: await this.candidates.reapply(id, body, user) };
  }

  @Get(':id/applications')
  async applications(@Param('id') id: string) {
    return { data: await this.candidates.listApplications(id) };
  }

  @Post(':id/complete')
  async complete(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    return { data: await this.candidates.complete(id, body, user) };
  }

  // Xoá mềm — hồ sơ chuyển vào Thùng rác.
  @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return { data: await this.candidates.remove(id, user) };
  }

  @Post(':id/restore')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  async restore(@Param('id') id: string) {
    return { data: await this.candidates.restore(id) };
  }
}
