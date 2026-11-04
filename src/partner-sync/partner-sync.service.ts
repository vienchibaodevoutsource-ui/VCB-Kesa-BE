import { BadGatewayException, BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PartnerSync } from '@prisma/client';
import { createHmac } from 'crypto';
import { AuthUser } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';
import { PartnerApiClient, PartnerQuestion, PartnerQuestionSet, PartnerWorkerMatch, postExec } from './partner-api.client';
import { EXTRA_FIELDS, ExtraField } from './partner-sync.fields';
import { autoInterviewAnswers, buildPartnerPayload } from './partner-sync.mapper';

const PARTNER = 'evergreen';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const NUMBER = /^\d+(\.\d+)?$/;
const YES_NO = ['是', '否'];

type Worker = ReturnType<typeof buildPartnerPayload>['worker'];
type LoadedCandidate = Awaited<ReturnType<PartnerSyncService['loadCandidate']>>;
type DuplicateView = PartnerWorkerMatch & { linkedCandidateCode: string | null };
// Bộ câu hỏi lúc đẩy thành công — chỉ giữ những gì cần để biết câu nào mới/đã sửa.
type QuestionSnapshot = { setId: string; questions: Array<Pick<PartnerQuestion, 'questionId' | 'labelZh' | 'type' | 'updatedAt'>> };
type QuestionStatus = 'new' | 'changed' | null;

// Đẩy thủ công 1 hồ sơ kesa vào 1 dự án của 長青 (Google Apps Script doPost), theo docs/partner-sync-changqing.md.
// Người dùng chọn dự án + nhập bổ sung các trường kesa không có (EXTRA_FIELDS) rồi bấm đẩy; đẩy lại thì 長青 cập nhật
// đúng worker cũ theo externalId. Lần đầu đẩy: dò hồ sơ kesa có sẵn bên 長青 (trùng tên + ngày sinh / SĐT) → người dùng
// phải chọn gắn vào hồ sơ có sẵn (gửi worker.workerId) hoặc tạo mới, tránh 1 người 2 hồ sơ.
// Sau khi đã gắn workerId thì không dò nữa.
// Câu hỏi phỏng vấn đọc động theo bộ câu hỏi của dự án (長青 có thể thêm/sửa/tắt câu): kesa tự điền theo questionId,
// câu còn lại người dùng trả lời; gửi sang 長青 trong worker.interview theo questionId.
// Lưu bộ câu hỏi lúc đẩy → lần sau so lại để báo hồ sơ cần bổ sung.
// Cấu hình qua env (thiếu 1 trong 3 biến đầu = tắt):
//   PARTNER_SYNC_URL          URL /exec của Apps Script (đẩy hồ sơ + API tra cứu dự án / worker)
//   PARTNER_SYNC_SECRET       khoá chung để ký HMAC-SHA256, đối tác dùng để xác thực
//   PARTNER_SYNC_ACCESS_CODE  mã truy cập kesa trên hệ thống đối tác (đại lý, không phải mã admin)
//   PARTNER_SYNC_COMPANY_IDS  id hoặc slug công ty (môi giới/nhà máy) được phép đẩy, cách nhau bởi dấu phẩy
@Injectable()
export class PartnerSyncService {
  private readonly logger = new Logger(PartnerSyncService.name);
  private readonly url: string;
  private readonly secret: string;
  private readonly accessCode: string;
  private readonly companyKeys: Set<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly api: PartnerApiClient,
    config: ConfigService,
  ) {
    this.url = config.get<string>('PARTNER_SYNC_URL')?.trim() ?? '';
    this.secret = config.get<string>('PARTNER_SYNC_SECRET')?.trim() ?? '';
    this.accessCode = config.get<string>('PARTNER_SYNC_ACCESS_CODE')?.trim() ?? '';
    this.companyKeys = new Set(
      (config.get<string>('PARTNER_SYNC_COMPANY_IDS') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    if (this.url && !(this.secret && this.accessCode)) {
      this.logger.warn('PARTNER_SYNC_URL đã đặt nhưng thiếu PARTNER_SYNC_SECRET / PARTNER_SYNC_ACCESS_CODE → tắt đẩy hồ sơ');
    }
  }

  isEnabled() {
    return Boolean(this.url && this.secret && this.accessCode);
  }

  async listProjects() {
    try {
      return await this.api.listActiveProjects();
    } catch (err) {
      throw new BadGatewayException(errorMessage(err));
    }
  }

  // Dữ liệu cho dialog: trạng thái lần đẩy trước + từng trường bổ sung (giá trị map từ form và giá trị đã nhập lần trước)
  // + câu hỏi phỏng vấn của dự án đang chọn (mặc định dự án đã đẩy lần trước).
  async preview(candidateId: string, projectCode?: string) {
    const [candidate, sync] = await Promise.all([this.loadCandidate(candidateId), this.findSync(candidateId)]);
    const { worker } = buildPartnerPayload(candidate);
    const saved = stringRecord(sync?.extras);
    const snapshot = questionSnapshot(sync?.questionSnapshot);
    const auto = autoInterviewAnswers(candidate);
    const savedAnswers = stringRecord(sync?.answers);

    let questions: ReturnType<typeof questionViews> | null = null;
    let questionError: string | null = null;
    let questionChanges = 0;
    const picked = projectCode?.trim();
    // Mở trang (chưa chọn dự án): tải trước dò trùng + dự án để lúc mở dialog khỏi chờ ~22s.
    if (!picked && this.isEnabled() && !this.blockedReason(candidate)) this.api.warmUp();
    try {
      // Dialog vừa chọn dự án → lấy bộ câu hỏi mới nhất; lúc mở trang (badge) thì không chờ mạng.
      const set = picked
        ? await this.api.questionSet(picked, 'fresh')
        : sync?.projectCode ? await this.api.questionSet(sync.projectCode, 'peek') : null;
      if (set) questions = questionViews(set, snapshot, auto, savedAnswers);
      // Badge: bộ câu hỏi của dự án đã đẩy đổi so với lúc đẩy → hồ sơ cần mở ra bổ sung rồi đẩy lại.
      if (sync?.status === 'SENT' && sync.projectCode && snapshot) {
        const current = picked === sync.projectCode || !picked ? set : await this.api.questionSet(sync.projectCode, 'peek');
        questionChanges = current ? current.questions.filter((q) => questionStatus(q, current.setId, snapshot)).length : 0;
      }
    } catch (err) {
      questionError = errorMessage(err);
    }
    return {
      // false → FE ẩn nút (chưa cấu hình, hoặc hồ sơ không thuộc 長青)
      available: this.isEnabled() && this.isTargetCompany(candidate),
      blockedReason: this.blockedReason(candidate),
      sync: sync ? { ...this.syncView(sync, candidate.updatedAt), questionChanges } : null,
      questions,
      questionError,
      worker,
      fields: EXTRA_FIELDS.map((field) => ({
        ...field,
        mapped: mappedValue(field, worker, candidate),
        saved: saved[field.key] ?? '',
      })),
    };
  }

  // Tách khỏi preview: export_workers của 長青 chậm (~25s) → chỉ dò khi mở dialog, không dò lúc tải trang để hiện badge.
  async duplicates(candidateId: string) {
    const [candidate, sync] = await Promise.all([this.loadCandidate(candidateId), this.findSync(candidateId)]);
    try {
      return { duplicates: await this.findDuplicates(candidate, buildPartnerPayload(candidate).worker, sync?.partnerWorkerId), duplicateCheckError: null };
    } catch (err) {
      return { duplicates: [] as DuplicateView[], duplicateCheckError: errorMessage(err) };
    }
  }

  async push(candidateId: string, body: Record<string, unknown>, user: AuthUser) {
    if (!this.isEnabled()) throw new BadRequestException('Chưa cấu hình đẩy hồ sơ sang 長青');
    const projectCode = typeof body.projectCode === 'string' ? body.projectCode.trim() : '';
    if (!projectCode) throw new BadRequestException('Chưa chọn dự án');

    // Các bước đọc không phụ thuộc nhau → chạy song song; dự án / câu hỏi thường đã nằm trong cache từ lúc mở dialog.
    const [candidate, sync, projects, set] = await Promise.all([
      this.loadCandidate(candidateId),
      this.findSync(candidateId),
      this.listProjects(),
      this.api.questionSet(projectCode).catch((err: unknown) => new Error(errorMessage(err))),
    ]);
    const blocked = this.blockedReason(candidate);
    if (blocked) throw new BadRequestException(blocked);
    if (!projects.some((p) => p.code === projectCode)) throw new BadRequestException('Dự án không tồn tại hoặc không còn 啟用');
    if (set instanceof Error) throw new BadGatewayException(`Không đọc được bộ câu hỏi của 長青: ${set.message}`);

    const { worker } = buildPartnerPayload(candidate);
    const extras = cleanExtras(body.extras, worker, candidate);
    const workerId = await this.resolveWorkerId(candidate, worker, body.duplicateChoice, sync);
    const auto = autoInterviewAnswers(candidate);
    const answers = set ? cleanAnswers(body.answers, set, auto) : {};
    const finalAnswers = set ? mergeAnswers(set, auto, answers) : {};
    const now = new Date().toISOString();
    // Không gửi raw: 長青 không đọc cũng không lưu (nhiều dữ liệu cá nhân, không có format cố định).
    // Ô trống = 長青 giữ nguyên giá trị cũ, kesa không xoá được trường bên họ.
    const payload = JSON.stringify({
      event: 'candidate.upserted',
      sentAt: now,
      // Đẩy thủ công: phần nhập bổ sung có thể đổi mà hồ sơ không đổi → version theo thời điểm đẩy, không theo updatedAt.
      version: now,
      accessCode: this.accessCode,
      application: {
        projectCode,
        introducer: extras.introducer ?? mappedValue(EXTRA_FIELDS[0], worker, candidate),
      },
      worker: {
        ...applyExtras(worker, extras),
        ...(workerId ? { workerId } : {}),
        // Key theo questionId (長青 khuyên dùng): họ sửa câu chữ vẫn khớp; câu không có trong bộ câu hỏi bị bỏ qua.
        interview: finalAnswers,
      },
    });

    const saved = {
      projectCode,
      extras: extras as Prisma.InputJsonObject,
      answers: answers as Prisma.InputJsonObject,
      sentById: user.id,
    };
    try {
      const response = await this.post(payload);
      // version không mới hơn lần đã lưu bên 長青 → họ không ghi gì; không coi là đã đẩy.
      if (response.skipped === 'stale') throw new Error('長青 bỏ qua vì version không mới hơn lần đẩy trước, chưa ghi gì — hãy đẩy lại');
      const sync = await this.saveSync(candidateId, {
        ...saved,
        status: 'SENT',
        lastError: null,
        lastSentAt: new Date(now),
        lastSentVersion: candidate.updatedAt,
        partnerWorkerId: response.workerId || workerId,
        questionSnapshot: set ? (toSnapshot(set) as Prisma.InputJsonObject) : Prisma.DbNull,
      });
      this.logger.log(`Đã đẩy hồ sơ ${candidate.candidateCode ?? candidate.id} vào dự án ${projectCode}`);
      return this.syncView(sync, candidate.updatedAt);
    } catch (err) {
      await this.saveSync(candidateId, { ...saved, status: 'FAILED', lastError: errorMessage(err).slice(0, 1000) });
      throw new BadGatewayException(`Đẩy sang 長青 thất bại: ${errorMessage(err)}`);
    }
  }

  // Đã gắn từ lần đẩy trước → dùng luôn. Chưa gắn → dò lại (mới nhất) và bắt người dùng chọn nếu có trùng.
  private async resolveWorkerId(candidate: LoadedCandidate, worker: Worker, choice: unknown, sync: PartnerSync | null): Promise<string | null> {
    if (sync?.partnerWorkerId) return sync.partnerWorkerId;

    let duplicates: DuplicateView[];
    try {
      duplicates = await this.findDuplicates(candidate, worker, null);
    } catch (err) {
      throw new BadGatewayException(`Không kiểm tra được hồ sơ trùng bên 長青: ${errorMessage(err)}`);
    }
    if (!duplicates.length) return null;

    const picked = typeof choice === 'string' ? choice.trim() : '';
    if (!picked) throw new ConflictException('Có hồ sơ có thể trùng bên 長青 — hãy chọn cập nhật hồ sơ có sẵn hoặc tạo mới');
    if (picked === 'new') return null;
    const match = duplicates.find((d) => d.workerId === picked);
    if (!match) throw new BadRequestException('Hồ sơ được chọn không nằm trong danh sách trùng');
    if (match.linkedCandidateCode) {
      throw new BadRequestException(`Hồ sơ ${picked} đã gắn với hồ sơ kesa ${match.linkedCandidateCode}`);
    }
    return picked;
  }

  // Kèm thông tin hồ sơ kesa khác đã gắn vào workerId đó (kesa có hồ sơ trùng nhau).
  private async findDuplicates(candidate: LoadedCandidate, worker: Worker, linkedWorkerId: string | null | undefined) {
    if (linkedWorkerId) return [];
    const matches = await this.api.findKesaWorkers(worker);
    if (!matches.length) return [];
    const links = await this.prisma.partnerSync.findMany({
      where: { partner: PARTNER, partnerWorkerId: { in: matches.map((m) => m.workerId) }, candidateId: { not: candidate.id } },
      select: { partnerWorkerId: true, candidate: { select: { id: true, candidateCode: true } } },
    });
    return matches.map((m): DuplicateView => {
      const link = links.find((l) => l.partnerWorkerId === m.workerId);
      return { ...m, linkedCandidateCode: link ? link.candidate.candidateCode ?? link.candidate.id : null };
    });
  }

  private async loadCandidate(id: string) {
    const candidate = await this.prisma.candidate.findUnique({
      where: { id },
      include: { familyMembers: true, broker: true, factory: true, formSnapshot: true, createdBy: { select: { name: true } } },
    });
    if (!candidate) throw new NotFoundException('Không tìm thấy hồ sơ');
    return candidate;
  }

  private blockedReason(candidate: LoadedCandidate) {
    if (candidate.status !== 'COMPLETED') return 'Hồ sơ nháp chưa đẩy được, hãy lưu hoàn tất trước';
    if (!this.isTargetCompany(candidate)) return 'Hồ sơ không thuộc công ty được đẩy sang 長青';
    return null;
  }

  private isTargetCompany(candidate: LoadedCandidate) {
    if (!this.companyKeys.size) return true;
    return [candidate.broker, candidate.factory].some((c) => c && (this.companyKeys.has(c.id) || this.companyKeys.has(c.slug)));
  }

  private findSync(candidateId: string) {
    return this.prisma.partnerSync.findUnique({ where: { candidateId_partner: { candidateId, partner: PARTNER } } });
  }

  private saveSync(candidateId: string, data: Omit<Prisma.PartnerSyncUncheckedCreateInput, 'candidateId' | 'partner'>) {
    return this.prisma.partnerSync.upsert({
      where: { candidateId_partner: { candidateId, partner: PARTNER } },
      create: { candidateId, partner: PARTNER, ...data },
      update: data,
    });
  }

  private syncView(sync: PartnerSync, candidateUpdatedAt: Date) {
    return {
      status: sync.status,
      projectCode: sync.projectCode,
      partnerWorkerId: sync.partnerWorkerId,
      lastSentAt: sync.lastSentAt,
      lastError: sync.status === 'FAILED' ? sync.lastError : null,
      changedSinceSent: Boolean(sync.lastSentVersion && candidateUpdatedAt > sync.lastSentVersion),
    };
  }

  // Apps Script không đọc được header của request → chữ ký nằm trong body, ký trên đúng chuỗi payload.
  // Đẩy thủ công nên không tự thử lại: lỗi trả về cho người dùng bấm lại.
  private post(payload: string) {
    const signature = createHmac('sha256', this.secret).update(payload, 'utf8').digest('hex');
    return postExec<{ workerId?: string; skipped?: string }>(this.url, { payload, signature });
  }
}

function mappedValue(field: ExtraField, worker: Worker, candidate: LoadedCandidate) {
  if (field.target === 'application') return candidate.createdBy?.name ?? '';
  const value = (worker as Record<string, unknown>)[field.key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

// Chỉ giữ giá trị hợp lệ và KHÁC giá trị map từ form → sửa form sau này vẫn được cập nhật, trừ trường đã sửa đè.
function cleanExtras(input: unknown, worker: Worker, candidate: LoadedCandidate) {
  const values = stringRecord(input);
  const result: Record<string, string> = {};
  for (const field of EXTRA_FIELDS) {
    const value = values[field.key]?.trim() ?? '';
    if (!value || value === mappedValue(field, worker, candidate)) continue;
    if (field.options && !field.options.includes(value)) continue;
    if (field.type === 'date' && !ISO_DATE.test(value)) continue;
    result[field.key] = value;
  }
  return result;
}

function applyExtras(worker: Worker, extras: Record<string, string>) {
  const merged: Record<string, unknown> = { ...worker };
  for (const field of EXTRA_FIELDS) {
    const value = extras[field.key];
    if (value && field.target === 'worker') merged[field.key] = value;
  }
  return merged;
}

function questionViews(set: PartnerQuestionSet, snapshot: QuestionSnapshot | null, auto: Record<string, string>, saved: Record<string, string>) {
  return {
    setId: set.setId,
    setName: set.setName,
    items: set.questions.map((q) => ({
      ...q,
      options: answerOptions(q),
      auto: auto[q.questionId] ?? '',
      saved: saved[q.questionId] ?? '',
      status: questionStatus(q, set.setId, snapshot),
    })),
  };
}

// So với bộ câu hỏi lúc đẩy: chưa từng đẩy → không đánh dấu; đổi bộ / câu chưa có → new; sửa câu chữ, loại, updatedAt → changed.
function questionStatus(q: PartnerQuestion, setId: string, snapshot: QuestionSnapshot | null): QuestionStatus {
  if (!snapshot) return null;
  const prev = snapshot.setId === setId ? snapshot.questions.find((p) => p.questionId === q.questionId) : undefined;
  if (!prev) return 'new';
  return prev.labelZh !== q.labelZh || prev.type !== q.type || prev.updatedAt !== q.updatedAt ? 'changed' : null;
}

function toSnapshot(set: PartnerQuestionSet): QuestionSnapshot {
  return {
    setId: set.setId,
    questions: set.questions.map(({ questionId, labelZh, type, updatedAt }) => ({ questionId, labelZh, type, updatedAt })),
  };
}

function questionSnapshot(value: unknown): QuestionSnapshot | null {
  const v = value as QuestionSnapshot | null;
  return v && typeof v.setId === 'string' && Array.isArray(v.questions) ? v : null;
}

function answerOptions(q: PartnerQuestion) {
  return q.type === 'yesno' && !q.options.length ? YES_NO : q.options;
}

// Như cleanExtras: chỉ lưu câu trả lời hợp lệ và khác giá trị kesa tự điền.
function cleanAnswers(input: unknown, set: PartnerQuestionSet, auto: Record<string, string>) {
  const values = stringRecord(input);
  const result: Record<string, string> = {};
  for (const q of set.questions) {
    const value = values[q.questionId]?.trim() ?? '';
    if (!value || value === auto[q.questionId]) continue;
    const options = answerOptions(q);
    if (options.length && !options.includes(value)) continue;
    if (q.type === 'number' && !NUMBER.test(value)) continue;
    result[q.questionId] = value;
  }
  return result;
}

function mergeAnswers(set: PartnerQuestionSet, auto: Record<string, string>, answers: Record<string, string>) {
  const result: Record<string, string> = {};
  for (const q of set.questions) {
    const value = answers[q.questionId] || auto[q.questionId];
    if (value) result[q.questionId] = value;
  }
  return result;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}
