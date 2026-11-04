import { Injectable, Logger } from '@nestjs/common';
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
  projects: string[]; // tên dự án đã ứng tuyển bên 長青, giúp nhận ra đúng người
}

const ACTIVE_STATUS = '啟用';
const MINUTE = 60_000;
const REQUEST_TIMEOUT_MS = 60_000;

// API của 長青 chậm (export_workers ~22s, list_questions / list_projects ~4-5s) → cache kiểu stale-while-revalidate:
// còn mới → trả luôn; cũ nhưng chưa quá hạn → trả bản cũ ngay và tải lại ngầm; chưa có / quá hạn → chờ tải.
// Các lượt tải trùng nhau (mở dialog bắn cùng lúc nhiều request, tải trước + mở dialog) dùng chung 1 lượt gọi.
class SwrCache<T> {
  private readonly entries = new Map<string, { value: T; at: number }>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(
    private readonly freshMs: number,
    private readonly staleMs: number,
    private readonly onError: (err: unknown) => void,
  ) {}

  async get(key: string, load: () => Promise<T>) {
    const hit = this.entries.get(key);
    const age = hit ? Date.now() - hit.at : Infinity;
    if (hit && age < this.freshMs) return hit.value;
    if (hit && age < this.staleMs) {
      this.background(key, load);
      return hit.value;
    }
    return this.refresh(key, load);
  }

  // Bản đang có (cũ mấy cũng được), không chờ mạng; cũ hoặc chưa có thì tải ngầm cho lần sau.
  peek(key: string, load: () => Promise<T>) {
    const hit = this.entries.get(key);
    if (!hit || Date.now() - hit.at >= this.freshMs) this.background(key, load);
    return hit?.value ?? null;
  }

  refresh(key: string, load: () => Promise<T>) {
    const running = this.inflight.get(key);
    if (running) return running;
    const promise = load()
      .then((value) => {
        this.entries.set(key, { value, at: Date.now() });
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  background(key: string, load: () => Promise<T>) {
    this.refresh(key, load).catch(this.onError);
  }
}

// Tra cứu qua API của 長青 trên cùng URL /exec (docs/partner-sync-changqing.md mục 0), xác thực bằng access code
// — 長青 không cấp quyền đọc Google Sheet, và chỉ trả dự án / worker của kesa:
// - list_projects: dự án của kesa (chỉ lấy dự án 啟用)
// - list_questions: bộ câu hỏi phỏng vấn đang dùng của dự án (長青 có thể thêm/sửa/tắt câu bất cứ lúc nào)
// - export_workers: hồ sơ kesa đã có bên họ, để cảnh báo trùng trước khi đẩy
// Cấu hình qua env: PARTNER_SYNC_URL, PARTNER_SYNC_ACCESS_CODE (xem PartnerSyncService).
@Injectable()
export class PartnerApiClient {
  private readonly logger = new Logger(PartnerApiClient.name);
  private readonly url: string;
  private readonly accessCode: string;
  private readonly warn = (err: unknown) => this.logger.warn(`Tải ngầm dữ liệu 長青 lỗi: ${err instanceof Error ? err.message : err}`);
  private readonly projects = new SwrCache<PartnerProject[]>(5 * MINUTE, 60 * MINUTE, this.warn);
  private readonly questions = new SwrCache<PartnerQuestionSet>(5 * MINUTE, 30 * MINUTE, this.warn);
  // Hồ sơ 長青 vừa nhập tay có thể chưa thấy tới ~15 phút, nhưng 長青 vẫn tự khớp tên + ngày sinh + quốc tịch + đại lý khi nhận.
  private readonly workers = new SwrCache<Array<Record<string, unknown>>>(2 * MINUTE, 15 * MINUTE, this.warn);

  constructor(config: ConfigService) {
    this.url = config.get<string>('PARTNER_SYNC_URL')?.trim() ?? '';
    this.accessCode = config.get<string>('PARTNER_SYNC_ACCESS_CODE')?.trim() ?? '';
  }

  isEnabled() {
    return Boolean(this.url && this.accessCode);
  }

  async listActiveProjects(): Promise<PartnerProject[]> {
    if (!this.isEnabled()) return [];
    return this.projects.get('all', () => this.loadProjects());
  }

  // Tải trước lúc mở trang hồ sơ (không chờ): tới khi bấm mở dialog thì dò trùng / danh sách dự án đã có sẵn.
  warmUp() {
    if (!this.isEnabled()) return;
    void this.projects.get('all', () => this.loadProjects()).catch(this.warn);
    void this.workers.get('all', () => this.loadWorkers()).catch(this.warn);
  }

  // Câu 啟用 của bộ câu hỏi dự án đang dùng, theo sortOrder. 長青 sửa là có hiệu lực ngay, nên:
  // - fresh: dialog vừa chọn dự án → luôn lấy mới như họ khuyên
  // - cached: lúc bấm đẩy → dùng bản dialog vừa lấy
  // - peek: badge lúc tải trang → không chờ mạng, dùng bản đang có (tải ngầm cho lần sau)
  async questionSet(projectCode: string, mode: 'fresh' | 'cached' | 'peek' = 'cached'): Promise<PartnerQuestionSet | null> {
    if (!this.isEnabled() || !projectCode) return null;
    const load = () => this.loadQuestions(projectCode);
    if (mode === 'peek') return this.questions.peek(projectCode, load);
    return mode === 'fresh' ? this.questions.refresh(projectCode, load) : this.questions.get(projectCode, load);
  }

  private async loadProjects() {
    const { projects } = await this.call<{ projects?: Array<Record<string, unknown>> }>('list_projects');
    return (projects ?? [])
      .filter((p) => text(p.status) === ACTIVE_STATUS && text(p.code))
      .map((p) => ({ code: text(p.code), name: text(p.name), label: text(p.label) || text(p.name) || text(p.code) }));
  }

  private async loadQuestions(projectCode: string): Promise<PartnerQuestionSet> {
    const res = await this.call<{ setId?: unknown; setName?: unknown; questions?: Array<Record<string, unknown>> }>('list_questions', { projectCode });
    return {
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
  }

  // Trùng = cùng tên + ngày sinh, hoặc cùng tên + SĐT (ngày sinh gõ lệch). Chỉ trùng tên thì KHÔNG tính:
  // tên Việt trùng nhiều (đối chiếu thử 2026-11-03: ~180 cặp cùng tên đều khác ngày sinh lẫn SĐT).
  // Danh sách worker lấy qua cache (xem workers): tải trước lúc mở trang, dùng lại lúc bấm đẩy.
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
      const projects = Array.isArray(w.projects) ? w.projects.map(text).filter(Boolean) : [];
      if (match) matches.push({ workerId, englishName: text(w.englishName), birthDate, match, projects });
    }
    return matches;
  }

  private kesaWorkers() {
    return this.workers.get('all', () => this.loadWorkers());
  }

  private async loadWorkers() {
    const { workers } = await this.call<{ workers?: Array<Record<string, unknown>> }>('export_workers', { includePhotos: false });
    return workers ?? [];
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
