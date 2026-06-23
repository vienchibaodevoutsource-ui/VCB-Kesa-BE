import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { AuthUser } from '../common/types';
import { CandidatesService } from './candidates.service';

@Controller('candidates')
@UseGuards(AuthGuard)
export class CandidatesController {
  constructor(private readonly candidates: CandidatesService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.candidates.list(query);
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

  @Get(':id')
  async get(@Param('id') id: string) {
    return { data: await this.candidates.get(id) };
  }

  @Patch(':id')
  async autosave(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    return { data: await this.candidates.autosaveDraft(id, body, user) };
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return { data: await this.candidates.update(id, body) };
  }

  @Post(':id/complete')
  async complete(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    return { data: await this.candidates.complete(id, body, user) };
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return { data: await this.candidates.remove(id) };
  }
}
