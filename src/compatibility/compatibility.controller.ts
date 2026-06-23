import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { RegistrationStatus, Role } from '@prisma/client';
import { Response } from 'express';
import { AiService } from '../ai/ai.service';
import { AUTH_COOKIE, AuthService } from '../auth/auth.service';
import { CandidateCodesService } from '../candidate-codes/candidate-codes.service';
import { CandidatesService } from '../candidates/candidates.service';
import { CompaniesService } from '../companies/companies.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/types';
import { UploadedFile as UploadedFileType } from '../common/types/uploaded-file';
import { ExportsService } from '../exports/exports.service';
import { FormsService } from '../forms/forms.service';
import { RegistrationsService } from '../registrations/registrations.service';
import { TeamCodesService } from '../team-codes/team-codes.service';
import { UploadsService } from '../uploads/uploads.service';
import { UsersService } from '../users/users.service';

@Controller('api')
export class CompatibilityController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly teamCodes: TeamCodesService,
    private readonly companies: CompaniesService,
    private readonly candidateCodes: CandidateCodesService,
    private readonly candidates: CandidatesService,
    private readonly ai: AiService,
    private readonly uploads: UploadsService,
    private readonly exportsService: ExportsService,
    private readonly forms: FormsService,
    private readonly registrations: RegistrationsService,
  ) {}

  @Post('auth/login')
  async login(@Body() body: { email: string; password: string }, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.login(body.email, body.password);
    response.cookie(AUTH_COOKIE, result.token, this.auth.cookieOptions());
    return { user: result.user };
  }

  @Post('auth/logout')
  logout(@Res({ passthrough: true }) response: Response) {
    response.clearCookie(AUTH_COOKIE, { path: '/' });
    return { success: true };
  }

  @Get('auth/me')
  @UseGuards(AuthGuard)
  async me(@CurrentUser() user: AuthUser) {
    return { user: await this.auth.getActiveUser(user) };
  }

  @Get('users')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  async listUsers(@Query() query: Record<string, unknown>) {
    return this.unwrapList(await this.users.list(query));
  }

  @Post('users')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  createUser(@Body() body: Parameters<UsersService['create']>[0]) {
    return this.users.create(body);
  }

  @Put('users/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  updateUser(@Param('id') id: string, @Body() body: Parameters<UsersService['update']>[1], @CurrentUser() user: AuthUser) {
    return this.users.update(id, body, user);
  }

  @Delete('users/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  removeUser(@Param('id') id: string) {
    return this.users.remove(id);
  }

  @Get('team-codes')
  @UseGuards(AuthGuard)
  listTeamCodes() {
    return this.teamCodes.list();
  }

  @Post('team-codes')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  createTeamCode(@Body() body: Parameters<TeamCodesService['create']>[0]) {
    return this.teamCodes.create(body);
  }

  @Patch('team-codes/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  updateTeamCode(@Param('id') id: string, @Body() body: Parameters<TeamCodesService['update']>[1]) {
    return this.teamCodes.update(id, body);
  }

  @Delete('team-codes/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  removeTeamCode(@Param('id') id: string) {
    return this.teamCodes.remove(id);
  }

  @Get('companies')
  @UseGuards(AuthGuard)
  async listCompanies(@Query() query: Record<string, unknown>) {
    return this.unwrapList(await this.companies.list(query));
  }

  @Post('companies')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  createCompany(@Body() body: Parameters<CompaniesService['create']>[0]) {
    return this.companies.create(body);
  }

  @Put('companies/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  updateCompany(@Param('id') id: string, @Body() body: Parameters<CompaniesService['update']>[1]) {
    return this.companies.update(id, body);
  }

  @Delete('companies/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  removeCompany(@Param('id') id: string) {
    return this.companies.remove(id);
  }

  @Get('candidate-code')
  @UseGuards(AuthGuard)
  async candidateCode(@CurrentUser() user: AuthUser) {
    return {
      nextNumber: await this.candidateCodes.getNextGlobalCodeNumber(),
      teamCode: user.teamCode?.trim().toUpperCase() || null,
    };
  }

  @Get('candidates')
  @UseGuards(AuthGuard)
  async listCandidates(@Query() query: Record<string, unknown>) {
    return this.unwrapList(await this.candidates.list(query));
  }

  @Post('candidates')
  @UseGuards(AuthGuard)
  createCandidate(@Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    return this.candidates.create(body, user);
  }

  @Post('candidates/draft')
  @UseGuards(AuthGuard)
  createDraft(@Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    return this.candidates.createDraft(body, user);
  }

  @Get('candidates/check-cccd')
  @UseGuards(AuthGuard)
  checkCccd(
    @Query('cccd') cccd?: string,
    @Query('phone') phone?: string,
    @Query('excludeId') excludeId?: string,
  ) {
    return this.candidates.checkCccd(cccd, phone, excludeId);
  }

  @Get('candidates/:id')
  @UseGuards(AuthGuard)
  getCandidate(@Param('id') id: string) {
    return this.candidates.get(id);
  }

  @Patch('candidates/:id')
  @UseGuards(AuthGuard)
  autosaveCandidate(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    return this.candidates.autosaveDraft(id, body, user);
  }

  @Put('candidates/:id')
  @UseGuards(AuthGuard)
  updateCandidate(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.candidates.update(id, body);
  }

  @Post('candidates/:id/complete')
  @UseGuards(AuthGuard)
  completeCandidate(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    return this.candidates.complete(id, body, user);
  }

  @Delete('candidates/:id')
  @UseGuards(AuthGuard)
  removeCandidate(@Param('id') id: string) {
    return this.candidates.remove(id);
  }

  @Post('translate')
  @UseGuards(AuthGuard)
  async translate(@Body() body: { texts: Record<string, unknown>; targetLang?: string }) {
    const result = await this.ai.translate(body.texts, body.targetLang || 'zh');
    return result.data;
  }

  @Post('import-text')
  async importText(@Body('text') text: string) {
    return { success: true, data: this.ai.parseRawText(text) };
  }

  @Get('deepseek-balance')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  async balance() {
    return (await this.ai.getDeepSeekBalance()).data;
  }

  @Post('upload-image')
  @UseGuards(AuthGuard)
  @UseInterceptors(FileInterceptor('file'))
  async uploadImage(@UploadedFile() file: UploadedFileType, @Body() body: Record<string, string>) {
    return this.uploads.uploadImage(file, body);
  }

  @Post('export-docx')
  @UseGuards(AuthGuard)
  async exportDocx(@Body() body: Record<string, unknown>, @Res() response: Response) {
    const buffer = await this.exportsService.htmlToDocx(body);
    response
      .status(200)
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': 'attachment',
      })
      .send(buffer);
  }

  @Post('export-candidate-docx')
  @UseGuards(AuthGuard)
  async exportCandidateDocx(@Body() body: Record<string, unknown>, @Res() response: Response) {
    const { buffer, filename } = await this.exportsService.candidateDocx(body);
    response
      .status(200)
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      })
      .send(buffer);
  }

  @Get('forms')
  @UseGuards(AuthGuard)
  listForms() {
    return this.forms.listSchemas();
  }

  @Get('forms/resolve')
  @UseGuards(AuthGuard)
  resolveForm(@Query() query: { brokerId?: string; factoryId?: string; brokerSlug?: string; factorySlug?: string; company?: string }) {
    return this.forms.resolve(query);
  }

  @Get('forms/:formType/schema')
  @UseGuards(AuthGuard)
  formSchema(@Param('formType') formType: string) {
    return this.forms.getSchema(formType);
  }

  @Post('export-candidates')
  @UseGuards(AuthGuard)
  async exportCandidates(@Body() body: Record<string, unknown>, @Res() response: Response) {
    const { buffer, filename } = await this.exportsService.candidatesXlsx(body);
    response
      .status(200)
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      })
      .send(buffer);
  }

  @Post('export-excel')
  @UseGuards(AuthGuard)
  exportExcel(@Body() body: Record<string, unknown>, @Res() response: Response) {
    const { buffer, filename } = this.exportsService.candidatesCsv(body);
    response
      .status(200)
      .set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename=${filename}`,
      })
      .send(buffer);
  }

  @Post('registrations')
  async createRegistration(@Body() body: Record<string, unknown>) {
    return this.mapRegistration(await this.registrations.create(body));
  }

  @Get('registrations')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  async listRegistrations(@Query('status') status?: string) {
    const result = await this.registrations.list(status);
    return result.data.map((item) => this.mapRegistration(item));
  }

  @Put('registrations/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  async updateRegistration(@Param('id') id: string, @Body() body: { status: RegistrationStatus; reviewNote?: string }) {
    return this.mapRegistration(await this.registrations.updateStatus(id, body.status));
  }

  @Delete('registrations/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  removeRegistration(@Param('id') id: string) {
    return this.registrations.remove(id);
  }

  private unwrapList(result: { data?: unknown[]; total?: number; stats?: unknown }) {
    if (!Array.isArray(result.data)) return result;
    return result.total === undefined ? result.data : result;
  }

  private mapRegistration(item: { id: string; status: RegistrationStatus; payloadJson: string | null; note: string | null; createdAt: Date }) {
    const payload = item.payloadJson ? this.safeJson(item.payloadJson) : {};
    return {
      ...payload,
      id: item.id,
      status: item.status,
      reviewNote: payload.reviewNote ?? item.note ?? null,
      createdAt: item.createdAt,
      skills: Array.isArray(payload.skills) ? payload.skills : [],
      fullName: payload.fullName ?? 'Unknown',
      phone: payload.phone ?? '',
      gender: payload.gender ?? '',
    };
  }

  private safeJson(value: string): Record<string, any> {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }
}
