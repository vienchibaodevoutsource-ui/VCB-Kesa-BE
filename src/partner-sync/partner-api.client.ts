import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { normalizeSearch } from '../common/utils/normalize';
import { toIsoDate } from './partner-sync.mapper';

export interface PartnerProject {
  code: string;
  name: string;
  label: string;
}

export interface PartnerQuestion {
  questionId: string;
  sortOrder: number;
  section: string;
  type: string; // yesno | select | text | textarea | number (theo 長青)
  labelZh: string;
  labelVn: string;
  options: string[];
  updatedAt: string;
}

export interface PartnerQuestionSet {
  setId: string;
  setName: string;
  questions: PartnerQuestion[];
}

export interface PartnerWorkerMatch {
  workerId: string;
  englishName: string;
  birthDate: string;
  match: 'name+birthDate' | 'name+phone';
}

const ACTIVE_STATUS = '啟用';
const CACHE_MS = 5 * 60_000;
const WORKERS_CACHE_MS = 2 * 60_000;
const QUESTIONS_CACHE_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 60_000;

// Tra cứu qua API của 長青 trên cùng URL /exec (docs/partner-sync-changqing.md mục 0), xác thực bằng access code
// — 長青 không cấp quyền đọc Google Sheet, và chỉ trả dự án / worker của kesa:
// - list_projects: dự án của kesa (chỉ lấy dự án 啟用)
// - list_questions: bộ câu hỏi phỏng vấn đang dùng của dự án (長青 có thể thêm/sửa/tắt câu bất cứ lúc nào)
// - export_workers: hồ sơ kesa đã có bên họ, để cảnh báo trùng trước khi đẩy
// Cấu hình qua env: PARTNER_SYNC_URL, PARTNER_SYNC_ACCESS_CODE (xem PartnerSyncService).
@Injectable()
export class PartnerApiClient {
  private readonly url: string;
  private readonly accessCode: string;
  private projectsCache: { value: PartnerProject[]; expires: number } | null = null;
  private workersCache: { value: Array<Record<string, unknown>>; expires: number } | null = null;
  private questionsCache = new Map<string, { value: PartnerQuestionSet; expires: number }>();

  constructor(config: ConfigService) {
    this.url = config.get<string>('PARTNER_SYNC_URL')?.trim() ?? '';
    this.accessCode = config.get<string>('PARTNER_SYNC_ACCESS_CODE')?.trim() ?? '';
  }

  isEnabled() {
    return Boolean(this.url && this.accessCode);
  }

  async listActiveProjects(): Promise<PartnerProject[]> {
    if (!this.isEnabled()) return [];
    if (this.projectsCache && this.projectsCache.expires > Date.now()) return this.projectsCache.value;
    const { projects } = await this.call<{ projects?: Array<Record<string, unknown>> }>('list_projects');
    const value = (projects ?? [])
      .filter((p) => text(p.status) === ACTIVE_STATUS && text(p.code))
      .map((p) => ({ code: text(p.code), name: text(p.name), label: text(p.label) || text(p.name) || text(p.code) }));
    this.projectsCache = { value, expires: Date.now() + CACHE_MS };
    return value;
  }

  // Câu 啟用 của bộ câu hỏi dự án đang dùng, theo sortOrder. 長青 sửa là có hiệu lực ngay → dialog (chọn dự án)
  // gọi fresh như họ khuyên; badge lúc tải trang và lúc bấm đẩy dùng lại cache để không chờ thêm.
  async questionSet(projectCode: string, fresh = false): Promise<PartnerQuestionSet | null> {
    if (!this.isEnabled() || !projectCode) return null;
    const hit = this.questionsCache.get(projectCode);
    if (!fresh && hit && hit.expires > Date.now()) return hit.value;
    const res = await this.call<{ setId?: unknown; setName?: unknown; questions?: Array<Record<string, unknown>> }>('list_questions', { projectCode });
    const value: PartnerQuestionSet = {
      setId: text(res.setId) || 'default',
      setName: text(res.setName),
      questions: (res.questions ?? [])
        .filter((q) => text(q.questionId))
        .map((q) => ({
          questionId: text(q.questionId),
          sortOrder: Number(q.sortOrder) || 0,
          section: text(q.section),
          type: text(q.type) || 'text',
          labelZh: text(q.labelZh),
          labelVn: text((q.labels as Record<string, unknown> | undefined)?.vn),
          options: Array.isArray(q.options) ? q.options.map(text).filter(Boolean) : [],
          updatedAt: text(q.updatedAt),
        }))
        .sort((a, b) => a.sortOrder - b.sortOrder),
    };
    this.questionsCache.set(projectCode, { value, expires: Date.now() + QUESTIONS_CACHE_MS });
    return value;
  }

  // Trùng = cùng tên + ngày sinh, hoặc cùng tên + SĐT (ngày sinh gõ lệch). Chỉ trùng tên thì KHÔNG tính:
  // tên Việt trùng nhiều (đối chiếu thử 2026-11-03: ~180 cặp cùng tên đều khác ngày sinh lẫn SĐT).
  // export_workers chậm (~25s) → cache ngắn để mở dialog rồi bấm đẩy chỉ chờ 1 lần; hồ sơ 長青 vừa nhập tay
  // có thể chưa thấy trong 2 phút, nhưng 長青 vẫn tự khớp tên + ngày sinh + quốc tịch + đại lý khi nhận.
  async findKesaWorkers(person: { englishName: string; birthDate: string; phone: string }): Promise<PartnerWorkerMatch[]> {
    if (!this.isEnabled()) return [];
    const name = matchName(person.englishName);
    const phone = phoneKey(person.phone);
    if (!name) return [];

    const matches: PartnerWorkerMatch[] = [];
    for (const w of await this.kesaWorkers()) {
      const workerId = text(w.workerId);
      if (!workerId || matchName(text(w.englishName)) !== name) continue;
      const birthDate = toIsoDate(text(w.birthDate));
      const match = person.birthDate && birthDate === person.birthDate ? 'name+birthDate' : phone && phoneKey(text(w.phone)) === phone ? 'name+phone' : null;
      if (match) matches.push({ workerId, englishName: text(w.englishName), birthDate, match });
    }
    return matches;
  }

  private async kesaWorkers() {
    if (this.workersCache && this.workersCache.expires > Date.now()) return this.workersCache.value;
    const { workers } = await this.call<{ workers?: Array<Record<string, unknown>> }>('export_workers', { includePhotos: false });
    this.workersCache = { value: workers ?? [], expires: Date.now() + WORKERS_CACHE_MS };
    return this.workersCache.value;
  }

  private call<T>(action: string, params: Record<string, unknown> = {}) {
    return postExec<T>(this.url, { action, accessCode: this.accessCode, ...params });
  }
}

// /exec của Apps Script trả 302 sang script.googleusercontent.com; fetch tự follow (đổi thành GET) để lấy kết quả.
// Lỗi runtime của Apps Script trả trang HTML thay vì JSON → coi là lỗi.
export async function postExec<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 300)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Phản hồi không phải JSON: ${raw.slice(0, 300)}`);
  }
  const result = parsed as { success?: boolean; error?: string };
  if (result.success === false) throw new Error(result.error || 'Đối tác trả về success=false');
  return parsed as T;
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

// NFKC: hồ sơ 長青 có tên gõ chữ toàn độ rộng (vd "ＮONG"); bỏ dấu như englishName của kesa.
function matchName(value: string) {
  return normalizeSearch(value.normalize('NFKC')).toUpperCase();
}

// SĐT bên 長青 thường mất số 0 đầu (lưu dạng số) → so 9 số cuối.
function phoneKey(value: string) {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : '';
}
