import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { AuthUser } from '../common/types';
import { PartnerSyncService } from './partner-sync.service';

// Đẩy hồ sơ sang dự án của 長青. FE gọi qua /api/* (rewrite của Next) nên khai báo cả 2 tiền tố.
@Controller(['partner-sync', 'api/partner-sync'])
@UseGuards(AuthGuard)
export class PartnerSyncController {
  constructor(private readonly partnerSync: PartnerSyncService) {}

  @Get('projects')
  async projects() {
    return { data: await this.partnerSync.listProjects() };
  }

  @Get('candidates/:id')
  async preview(@Param('id') id: string, @Query('projectCode') projectCode?: string) {
    return { data: await this.partnerSync.preview(id, projectCode) };
  }

  @Get('candidates/:id/duplicates')
  async duplicates(@Param('id') id: string) {
    return { data: await this.partnerSync.duplicates(id) };
  }

  @Post('candidates/:id/push')
  async push(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    return { data: await this.partnerSync.push(id, body, user) };
  }
}
