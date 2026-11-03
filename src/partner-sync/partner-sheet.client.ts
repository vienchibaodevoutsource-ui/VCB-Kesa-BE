import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSign } from 'crypto';
import { readFileSync } from 'fs';
import { normalizeSearch } from '../common/utils/normalize';
import { toIsoDate } from './partner-sync.mapper';

export interface PartnerProject {
  code: string;
  name: string;
  employerName: string;
  interviewDate: string;
  questionSetId: string;
}

export interface PartnerQuestion {
  questionId: string;
  sortOrder: number;
  section: string;
  type: string; // text | yesno | number | … (theo 長青)
  labelZh: string;
  labelVn: string;
  options: string[];
  updatedAt: string;
}

export interface PartnerQuestionSet {
  setId: string;
  questions: PartnerQuestion[];
}

export interface PartnerWorkerMatch {
  workerId: string;
  englishName: string;
  birthDate: string;
  match: 'name+birthDate' | 'name+phone';
  projectCodes: string[];
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const ACTIVE_STATUS = '啟用';
const CACHE_MS = 5 * 60_000;
const DEFAULT_QUESTION_SET = 'default';
const SHEET_EPOCH_MS = Date.UTC(1899, 11, 30);

// Đọc (chỉ đọc, qua service account) Google Sheet của 長青:
// - danh sách dự án đang 啟用 của kesa (Project_Settings)
// - bộ câu hỏi phỏng vấn của từng dự án (Interview_Questions) — họ có thể thêm/sửa/tắt câu bất cứ lúc nào
// - hồ sơ kesa đã có bên họ (Worker_Profiles + Interview_Applications) để cảnh báo trùng trước khi đẩy
// Cấu hình qua env:
//   PARTNER_SHEET_ID           id Google Spreadsheet của đối tác
//   PARTNER_SHEET_CREDENTIALS  JSON service account (nội dung, hoặc đường dẫn file)
//   PARTNER_AGENCY_CODE        mã đại lý kesa bên đối tác (Project_Settings cột D, giữa workerId), mặc định KESA
@Injectable()
export class PartnerSheetClient {
  private readonly logger = new Logger(PartnerSheetClient.name);
  private readonly sheetId: string;
  private readonly agencyCode: string;
  private readonly account: ServiceAccount | null;
  private token: { value: string; expires: number } | null = null;
  private projectsCache: { value: PartnerProject[]; expires: number } | null = null;
  private questionsCache: { value: unknown[][]; expires: number } | null = null;

  constructor(config: ConfigService) {
    this.sheetId = config.get<string>('PARTNER_SHEET_ID')?.trim() ?? '';
    this.agencyCode = config.get<string>('PARTNER_AGENCY_CODE')?.trim() || 'KESA';
    this.account = this.loadAccount(config.get<string>('PARTNER_SHEET_CREDENTIALS')?.trim() ?? '');
  }

  isEnabled() {
    return Boolean(this.sheetId && this.account);
  }

  async listActiveProjects(): Promise<PartnerProject[]> {
    if (!this.isEnabled()) return [];
    if (this.projectsCache && this.projectsCache.expires > Date.now()) return this.projectsCache.value;
    const rows = await this.values('Project_Settings!A2:I');
    const value = rows
      .filter((r) => text(r[3]) === this.agencyCode && text(r[6]) === ACTIVE_STATUS)
      .map((r) => ({
        code: text(r[0]),
        name: text(r[1]),
        employerName: text(r[2]),
        interviewDate: text(r[5]),
        questionSetId: text(r[8]) || DEFAULT_QUESTION_SET, // cột I trống = bộ mặc định
      }));
    this.projectsCache = { value, expires: Date.now() + CACHE_MS };
    return value;
  }

  // Câu hỏi đang active của bộ câu hỏi mà dự án dùng, theo sortOrder. null = dự án không còn 啟用.
  async questionSet(projectCode: string): Promise<PartnerQuestionSet | null> {
    const project = (await this.listActiveProjects()).find((p) => p.code === projectCode);
    if (!project) return null;
    if (!this.questionsCache || this.questionsCache.expires < Date.now()) {
      this.questionsCache = { value: await this.values('Interview_Questions!A2:O'), expires: Date.now() + CACHE_MS };
    }
    const questions = this.questionsCache.value
      .filter((r) => text(r[0]) === project.questionSetId && text(r[13]).toUpperCase() === 'Y' && text(r[1]))
      .map((r) => ({
        questionId: text(r[1]),
        sortOrder: Number(text(r[2])) || 0,
        section: text(r[3]),
        type: text(r[4]) || 'text',
        labelZh: text(r[5]),
        labelVn: text(r[8]),
        options: text(r[10]).split(/[,，|\n]/).map((o) => o.trim()).filter(Boolean),
        updatedAt: text(r[14]),
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder);
    return { setId: project.questionSetId, questions };
  }

  // Trùng = cùng tên + ngày sinh, hoặc cùng tên + SĐT (ngày sinh gõ lệch). Chỉ trùng tên thì KHÔNG tính:
  // tên Việt trùng nhiều (đối chiếu thử 2026-11-03: ~180 cặp cùng tên đều khác ngày sinh lẫn SĐT).
  // Không cache: đọc mới mỗi lần để thấy cả hồ sơ 長青 vừa nhập tay.
  async findKesaWorkers(person: { englishName: string; birthDate: string; phone: string }): Promise<PartnerWorkerMatch[]> {
    if (!this.isEnabled()) return [];
    const name = matchName(person.englishName);
    const phone = phoneKey(person.phone);
    if (!name) return [];

    const [workers, applications] = await Promise.all([
      this.values('Worker_Profiles!A2:O', 'UNFORMATTED_VALUE'),
      this.values('Interview_Applications!B2:C'),
    ]);
    const prefix = `-${this.agencyCode}-`;
    const matches: PartnerWorkerMatch[] = [];
    for (const r of workers) {
      const workerId = text(r[0]);
      if (!workerId.includes(prefix) || matchName(text(r[1])) !== name) continue;
      const birthDate = sheetDate(r[6]);
      const match = person.birthDate && birthDate === person.birthDate ? 'name+birthDate' : phone && phoneKey(text(r[14])) === phone ? 'name+phone' : null;
      if (!match) continue;
      const projectCodes = applications.filter((a) => text(a[1]) === workerId).map((a) => text(a[0]));
      matches.push({ workerId, englishName: text(r[1]), birthDate, match, projectCodes });
    }
    return matches;
  }

  private async values(range: string, render: 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' = 'FORMATTED_VALUE') {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}/values/${encodeURIComponent(range)}?valueRenderOption=${render}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${await this.accessToken()}` } });
    if (!res.ok) throw new Error(`Không đọc được sheet 長青 ${range.split('!')[0]} (HTTP ${res.status})`);
    return ((await res.json()) as { values?: unknown[][] }).values ?? [];
  }

  private loadAccount(source: string): ServiceAccount | null {
    if (!source) return null;
    try {
      const json = source.startsWith('{') ? source : readFileSync(source, 'utf8');
      return JSON.parse(json) as ServiceAccount;
    } catch (err) {
      this.logger.warn(`PARTNER_SHEET_CREDENTIALS không hợp lệ: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  // OAuth2 service account (JWT bearer) — tự ký RS256, không cần thêm thư viện google.
  private async accessToken() {
    if (this.token && this.token.expires > Date.now()) return this.token.value;
    const account = this.account!;
    const now = Math.floor(Date.now() / 1000);
    const encode = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iss: account.client_email,
      scope: SCOPE,
      aud: account.token_uri,
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key, 'base64url');

    const res = await fetch(account.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }),
    });
    if (!res.ok) throw new Error(`Không lấy được token Google (HTTP ${res.status})`);
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
    return this.token.value;
  }
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

// NFKC: sheet có tên gõ chữ toàn độ rộng (vd "ＮONG"); bỏ dấu như englishName của kesa.
function matchName(value: string) {
  return normalizeSearch(value.normalize('NFKC')).toUpperCase();
}

// SĐT trong sheet 長青 thường mất số 0 đầu (lưu dạng số) → so 9 số cuối.
function phoneKey(value: string) {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : '';
}

// Ngày sinh trong sheet lưu dạng số serial (UNFORMATTED_VALUE) hoặc chuỗi.
function sheetDate(value: unknown) {
  if (typeof value === 'number') return new Date(SHEET_EPOCH_MS + Math.round(value) * 86_400_000).toISOString().slice(0, 10);
  return toIsoDate(text(value));
}
