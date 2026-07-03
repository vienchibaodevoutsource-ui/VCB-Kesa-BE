import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Docxtemplater from 'docxtemplater';
import ExcelJS from 'exceljs';
import { existsSync, readFileSync } from 'fs';
import HTMLtoDOCX from 'html-to-docx';
import { join } from 'path';
import PizZip from 'pizzip';
import { FormsService } from '../forms/forms.service';
import { FormType } from '../forms/forms.registry';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeDocxFontSizesInZip } from './docx-font.util';
import { embedPhotoIntoDocx } from './docx-image.util';

const EDUCATION_ZH: Record<string, string> = {
  'Cấp 1': '小學',
  'Tiểu học': '小學',
  'Cấp 2': '國中',
  THCS: '國中',
  'Cấp 3': '高中',
  THPT: '高中',
  'Trung cấp': '職校',
  'Cao đẳng': '大專',
  'Đại học': '大學',
};

const MARITAL_ZH: Record<string, string> = {
  'Chưa kết hôn': '未婚',
  'Đã kết hôn': '已婚',
  'Ly hôn': '離婚',
  Góa: '喪偶',
};

const GENDER_ZH: Record<string, string> = {
  Nam: '男',
  Nữ: '女',
  Nu: '女',
};

const COMPANY_ZH: Record<string, string> = {
  'hoan-vu': '鴻運',
  'ung-minh': '擁明',
  'truong-thanh': '長青',
  'vinh-thang': '永勝',
  'dai-quan': '臺郡',
  'thanh-dai': '成大',
  'van-thong': '萬通',
  'an-dac': '恩德',
  standard: '長青',
};

const SHIFT_ZH: Record<string, string> = {
  'Ca sáng': '早班',
  'Ca tối': '晚班',
  'Đều được': '皆可',
  morning: '早班',
  evening: '晚班',
  both: '皆可',
  '早班': '早班',
  '晚班': '晚班',
  '皆可': '皆可',
  '都可': '皆可',
};

@Injectable()
export class ExportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly forms: FormsService,
  ) {}

  async htmlToDocx(body: Record<string, unknown>) {
    const html = typeof body.html === 'string' ? body.html : '';
    if (!html) throw new BadRequestException('Missing html');
    const marginTwips = body.matchPrint ? 170 : 720;
    const fileBuffer = await HTMLtoDOCX(html, undefined, {
      orientation: 'portrait',
      pageSize: { width: 11906, height: 16838 },
      margins: { top: marginTwips, right: marginTwips, bottom: marginTwips, left: marginTwips },
      fontSize: 20,
      table: { row: { cantSplit: true } },
    } as Record<string, unknown>);
    return fileBuffer instanceof Buffer ? fileBuffer : Buffer.from(fileBuffer as ArrayBuffer);
  }

  async candidateDocx(body: Record<string, unknown>) {
    const language = body.language === 'zh' ? 'zh' : 'vi';

    // Hybrid: frontend gửi sẵn context ĐÃ ĐIỀN (đã dịch + checkbox ■/□ + câu phỏng vấn).
    // Backend chỉ render context đó vào template (tái dùng logic đúng của frontend).
    const providedContext =
      body.context && typeof body.context === 'object' && !Array.isArray(body.context)
        ? (body.context as Record<string, unknown>)
        : null;

    let formType: FormType;
    let context: Record<string, unknown>;
    let nameForFile: string;

    if (providedContext) {
      formType = this.forms.normalizeFormType(body.formType) ?? 'standard';
      context = providedContext;
      nameForFile =
        this.stringValue(body.filename) ?? this.stringValue(providedContext.vietnameseName) ?? 'CV';
    } else {
      // Fallback (tương thích cũ): tự dựng context từ DB.
      const candidateId = this.stringValue(body.candidateId);
      if (!candidateId) throw new BadRequestException('Thieu candidateId');
      const candidate = await this.prisma.candidate.findUnique({
        where: { id: candidateId },
        include: { broker: true, factory: true, familyMembers: true, formSnapshot: true },
      });
      if (!candidate) throw new NotFoundException('Khong tim thay ho so');
      const snapshot = this.snapshotObject(candidate.formSnapshot?.data ?? candidate.formDataJson);
      const explicitType = this.forms.normalizeFormType(body.formType) ?? this.forms.normalizeFormType(snapshot.formType);
      formType =
        explicitType ??
        this.forms.resolveFormType({
          brokerSlug: candidate.broker?.slug,
          factorySlug: candidate.factory?.slug,
          company: candidate.company,
        });
      context = this.buildDocxContext(candidate, snapshot, formType, language);
      nameForFile = candidate.candidateCode || candidate.vietnameseName || candidate.id;
    }

    const templatePath = this.resolveTemplatePath(formType, language);
    const zip = new PizZip(readFileSync(templatePath));
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: () => '',
    });

    doc.render(context);
    this.applyCommonDocxFixes(zip, formType);

    // Nhúng ảnh hồ sơ nếu frontend gửi base64 + vị trí ô (vd Trường Thanh: bảng 0, ô r1c4).
    const photo = this.stringValue(body.photo);
    const cell = body.photoCell as { table?: number; row?: number; col?: number } | undefined;
    if (photo && cell && typeof cell.table === 'number') {
      try {
        embedPhotoIntoDocx(zip, photo, { table: cell.table, row: cell.row ?? 0, col: cell.col ?? 0 });
      } catch {
        // Ảnh lỗi không được chặn cả file Word.
      }
    }

    const buffer = zip.generate({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    }) as Buffer;
    return {
      buffer,
      filename: `${this.safeFilename(nameForFile)}-${formType}-${language}.docx`,
    };
  }

  async candidatesXlsx(body: Record<string, unknown>) {
    const candidateIds = Array.isArray(body.candidateIds) ? body.candidateIds.filter((id): id is string => typeof id === 'string') : [];
    if (!candidateIds.length) throw new BadRequestException('Chua chon ho so nao');
    const candidates = await this.prisma.candidate.findMany({
      where: { id: { in: candidateIds } },
      include: {
        interviews: { include: { interviewList: true } },
        familyMembers: true,
        broker: true,
        factory: true,
        formSnapshot: true,
      },
      orderBy: { candidateCode: 'asc' },
    });
    const ordered = candidateIds.map((id) => candidates.find((candidate) => candidate.id === id)).filter(Boolean) as typeof candidates;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Kesa';
    workbook.created = new Date();
    const ws = workbook.addWorksheet('外籍員工名單', {
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
    });

    ws.columns = [
      { header: '序號\nSTT', key: 'stt', width: 6 },
      { header: '履歷編號\nMã hồ sơ', key: 'code', width: 12 },
      { header: '中文姓名\nHọ tên (中)', key: 'zhName', width: 18 },
      { header: '越南語姓名\nHọ tên (Việt)', key: 'vnName', width: 22 },
      { header: '電話\nSố điện thoại', key: 'phone', width: 14 },
      { header: '性別\nGiới tính', key: 'gender', width: 8 },
      { header: '出生日期\nNgày sinh', key: 'dob', width: 13 },
      { header: '年齡\nTuổi', key: 'age', width: 7 },
      { header: '身高(cm)\nCao', key: 'height', width: 9 },
      { header: '體重(kg)\nNặng', key: 'weight', width: 9 },
      { header: '學歷\nHọc lực', key: 'edu', width: 10 },
      { header: '婚姻狀況\nHôn nhân', key: 'marital', width: 12 },
      { header: '應聘公司\nCông ty', key: 'company', width: 12 },
      { header: '工作經驗\nKinh nghiệm làm việc', key: 'exp', width: 48 },
      { header: '備註\nGhi chú', key: 'note', width: 32 },
      { header: '建檔日期\nNgày lưu', key: 'saved', width: 18 },
      { header: '數學\nĐiểm toán', key: 'mathScore', width: 12 },
      { header: '夾豆子\nGắp hạt đậu', key: 'beanCount', width: 14 },
      { header: '鏡片\nKiểm tra kính', key: 'lensCheck', width: 14 },
      { header: '班別\nCa làm việc', key: 'shiftChoice', width: 14 },
    ];

    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
    header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    header.height = 36;

    ordered.forEach((candidate, index) => {
      const snapshot = this.snapshotObject(candidate.formSnapshot?.data ?? candidate.formDataJson);
      const rowData = {
        stt: index + 1,
        code: candidate.candidateCode || '',
        zhName: candidate.chineseName || snapshot.chineseName || '',
        vnName: this.asciiUpper(candidate.vietnameseName || snapshot.vietnameseName || ''),
        phone: candidate.phone || snapshot.phone || '',
        gender: GENDER_ZH[candidate.gender] || candidate.gender || '',
        dob: this.formatDobYmd(candidate.dateOfBirth || snapshot.dateOfBirth || ''),
        age: candidate.age ?? snapshot.age ?? '',
        height: candidate.height ?? snapshot.height ?? '',
        weight: candidate.weight ?? snapshot.weight ?? '',
        edu: EDUCATION_ZH[candidate.education || ''] || candidate.education || '',
        marital: MARITAL_ZH[candidate.maritalStatus || ''] || candidate.maritalStatus || '',
        company: this.companyLabel(candidate.company, candidate.broker?.slug, candidate.factory?.slug),
        exp: this.mergeExperience(
          candidate.domesticExperience || snapshot.domesticExperience || '',
          candidate.overseasExperience || snapshot.internationalExperience || snapshot.overseasExperience || '',
        ),
        note: candidate.note || snapshot.note || snapshot.overallComment || '',
        saved: this.formatDateTime(candidate.createdAt),
        mathScore: this.firstText(snapshot.mathScore, snapshot.mathEnglishScore),
        beanCount: this.firstText(snapshot.beanCount, snapshot.beanPickingScore),
        lensCheck: this.firstText(snapshot.lensCheck, snapshot.glassesDegree),
        shiftChoice: this.shiftLabel(this.firstText(snapshot.shiftChoice, snapshot.shiftPreference)),
      };
      const row = ws.addRow(rowData);
      // Chiều cao dòng theo nội dung để KHÔNG che khuất ô nhiều dòng (tên xuống dòng, cột kinh nghiệm).
      row.height = this.estimateRowHeight(rowData, ws.columns);
      row.alignment = { vertical: 'middle', wrapText: true };
      if (index % 2 === 1) {
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4FF' } };
      }
    });

    ws.eachRow((row) => {
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
      });
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const title = typeof body.listTitle === 'string' && body.listTitle.trim() ? body.listTitle.trim() : '外籍員工名單';
    return { buffer, filename: `${this.safeFilename(title)}-${new Date().toISOString().slice(0, 10)}.xlsx` };
  }

  candidatesCsv(body: Record<string, unknown>) {
    const candidates = Array.isArray(body.candidates) ? body.candidates : [];
    if (!candidates.length) throw new BadRequestException('Danh sach ung vien khong hop le');
    const headers = ['Ho va Ten', 'Gioi tinh', 'Nam sinh', 'So dien thoai', 'Que quan', 'Chieu cao', 'Can nang', 'Kinh nghiem', 'Ghi chu'];
    const rows = [headers.join(',')];
    for (const raw of candidates) {
      const item = raw as Record<string, unknown>;
      rows.push(
        [item.fullName, item.gender, item.birthYear, item.phone, item.hometown, item.height, item.weight, item.experience, item.notes]
          .map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`)
          .join(','),
      );
    }
    return { buffer: Buffer.from(`\ufeff${rows.join('\n')}`, 'utf-8'), filename: 'danh_sach_lao_dong_kesa.csv' };
  }

  private resolveTemplatePath(formType: FormType, language: string) {
    const primary = join(process.cwd(), 'templates', 'forms', this.forms.getTemplateFile(formType, language));
    if (existsSync(primary)) return primary;
    const fallback = join(process.cwd(), 'templates', 'forms', this.forms.getTemplateFile(formType, 'vi'));
    if (existsSync(fallback)) return fallback;
    throw new NotFoundException(`Khong tim thay template ${formType}`);
  }

  private buildDocxContext(candidate: any, snapshot: Record<string, unknown>, formType: FormType, language: string) {
    const family = Array.isArray(candidate.familyMembers) ? candidate.familyMembers : [];
    const father = family.find((item: any) => item.relationship === 'father' || item.relationship === 'Bố' || item.relationship === '爸爸');
    const mother = family.find((item: any) => item.relationship === 'mother' || item.relationship === 'Mẹ' || item.relationship === '媽媽');
    const spouse = family.find((item: any) => item.relationship === 'spouse' || item.relationship === 'Vợ/chồng' || item.relationship === '配偶');
    const sons = family.filter((item: any) => item.relationship === 'son' || item.relationship === 'Con trai');
    const daughters = family.filter((item: any) => item.relationship === 'daughter' || item.relationship === 'Con gái');
    return {
      ...snapshot,
      formType,
      language,
      candidateCode: candidate.candidateCode || snapshot.candidateCode || '',
      chineseName: candidate.chineseName || snapshot.chineseName || '',
      vietnameseName: candidate.vietnameseName || snapshot.vietnameseName || '',
      gender: candidate.gender || snapshot.gender || '',
      dateOfBirth: candidate.dateOfBirth || snapshot.dateOfBirth || '',
      age: candidate.age ?? snapshot.age ?? '',
      height: candidate.height ?? snapshot.height ?? '',
      weight: candidate.weight ?? snapshot.weight ?? '',
      education: candidate.education || snapshot.education || '',
      maritalStatus: candidate.maritalStatus || snapshot.maritalStatus || '',
      address: candidate.address || snapshot.address || '',
      domesticExperience: candidate.domesticExperience || snapshot.domesticExperience || '',
      internationalExperience: candidate.overseasExperience || snapshot.internationalExperience || snapshot.overseasExperience || '',
      overseasExperience: candidate.overseasExperience || snapshot.overseasExperience || snapshot.internationalExperience || '',
      note: candidate.note || snapshot.note || '',
      company: this.companyLabel(candidate.company, candidate.broker?.slug, candidate.factory?.slug),
      brokerName: candidate.broker?.name || '',
      factoryName: candidate.factory?.name || snapshot.factoryName || '',
      fatherName: snapshot.fatherName || father?.name || '',
      fatherAge: snapshot.fatherAge || father?.age || '',
      fatherOccupation: snapshot.fatherOccupation || father?.occupation || '',
      motherName: snapshot.motherName || mother?.name || '',
      motherAge: snapshot.motherAge || mother?.age || '',
      motherOccupation: snapshot.motherOccupation || mother?.occupation || '',
      spouseName: snapshot.spouseName || spouse?.name || '',
      spouseAge: snapshot.spouseAge || spouse?.age || '',
      spouseOccupation: snapshot.spouseOccupation || spouse?.occupation || '',
      sonsCount: snapshot.sonsCount || sons.length,
      daughtersCount: snapshot.daughtersCount || daughters.length,
      sonsAge: snapshot.sonsAge || sons.map((item: any) => item.age).filter(Boolean).join(', '),
      daughtersAge: snapshot.daughtersAge || daughters.map((item: any) => item.age).filter(Boolean).join(', '),
      mathScore: this.firstText(snapshot.mathScore, snapshot.mathEnglishScore),
      beanCount: this.firstText(snapshot.beanCount, snapshot.beanPickingScore),
      lensCheck: this.firstText(snapshot.lensCheck, snapshot.glassesDegree),
      shiftChoice: this.shiftLabel(this.firstText(snapshot.shiftChoice, snapshot.shiftPreference)),
    };
  }

  private applyCommonDocxFixes(zip: PizZip, formType: FormType) {
    const documentXml = zip.file('word/document.xml')?.asText();
    if (!documentXml) return;
    let next = documentXml;
    if (formType === 'standard' || formType === 'truong-thanh') {
      next = next.replace(/專門/g, '');
    }
    next = next.replace(/\{[^{}]+\}/g, '');
    zip.file('word/document.xml', next);
    normalizeDocxFontSizesInZip(zip);
  }

  private snapshotObject(value: Prisma.JsonValue | string | null | undefined): Record<string, unknown> {
    if (!value) return {};
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }

  private companyLabel(company?: string | null, brokerSlug?: string | null, factorySlug?: string | null) {
    const formType = this.forms.resolveFormType({ brokerSlug, factorySlug, company });
    return COMPANY_ZH[factorySlug || ''] || COMPANY_ZH[formType] || company || '';
  }

  private firstText(...values: unknown[]) {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number') return String(value);
    }
    return '';
  }

  private shiftLabel(value: string) {
    return SHIFT_ZH[value] || value || '';
  }

  private stringValue(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private safeFilename(value: string) {
    return value.trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_') || 'export';
  }

  private formatDateTime(value: Date | string | null | undefined) {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('vi-VN', { hour12: false });
  }

  /** Tên tiếng Việt → Latin không dấu, IN HOA (vd "Trần Duy Tình" → "TRAN DUY TINH"). */
  private asciiUpper(value: unknown): string {
    const s = typeof value === 'string' ? value : value == null ? '' : String(value);
    return s
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .toUpperCase()
      .trim();
  }

  /** Chuẩn hoá ngày sinh về dạng yyyy/mm/dd (nhận cả yyyy-mm-dd và dd/mm/yyyy). */
  private formatDobYmd(value: unknown): string {
    const s = (typeof value === 'string' ? value : value == null ? '' : String(value)).trim();
    if (!s) return '';
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return `${m[1]}/${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
    if (m) return `${m[3]}/${m[2].padStart(2, '0')}/${m[1].padStart(2, '0')}`;
    return s;
  }

  /**
   * Ước lượng chiều cao dòng (point) theo nội dung để ô nhiều dòng không bị che khuất:
   * đếm số dòng do xuống hàng thủ công (\n) + tự wrap theo bề rộng cột (ký tự CJK tính ~2 đơn vị).
   */
  private estimateRowHeight(
    rowData: Record<string, unknown>,
    columns: ReadonlyArray<{ key?: string; width?: number }>,
  ): number {
    const LINE_PT = 16;
    const MIN_PT = 22;
    const MAX_PT = 300;
    let maxLines = 1;
    for (const col of columns) {
      if (!col.key) continue;
      const width = typeof col.width === 'number' && col.width > 0 ? col.width : 10;
      // Bề rộng hữu dụng ~80% (font tỉ lệ rộng hơn đơn vị cột) → ước lượng thận trọng, tránh cắt chữ.
      const usable = Math.max(1, width * 0.8);
      const value = rowData[col.key];
      const text = value == null ? '' : String(value);
      if (!text) continue;
      const lines = text.split('\n').reduce((sum, segment) => {
        // Ký tự CJK (Trung/Nhật/Hàn/fullwidth) rộng gấp đôi; chữ Việt có dấu vẫn tính 1.
        const units = [...segment].reduce((acc, ch) => acc + (ch.charCodeAt(0) > 0x2e7f ? 2 : 1), 0);
        return sum + Math.max(1, Math.ceil(units / usable));
      }, 0);
      if (lines > maxLines) maxLines = lines;
    }
    return Math.min(MAX_PT, Math.max(MIN_PT, maxLines * LINE_PT));
  }

  /** Gộp kinh nghiệm VN + Đài Loan thành một cột, mỗi phần một dòng. */
  private mergeExperience(...values: unknown[]): string {
    return values
      .map((v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim()))
      .filter(Boolean)
      .join('\n');
  }
}
