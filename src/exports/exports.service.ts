import { BadRequestException, Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import HTMLtoDOCX from 'html-to-docx';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ExportsService {
  constructor(private readonly prisma: PrismaService) {}

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

  async candidatesXlsx(body: Record<string, unknown>) {
    const candidateIds = Array.isArray(body.candidateIds) ? body.candidateIds.filter((id): id is string => typeof id === 'string') : [];
    if (!candidateIds.length) throw new BadRequestException('Chua chon ho so nao');
    const candidates = await this.prisma.candidate.findMany({
      where: { id: { in: candidateIds } },
      include: { interviews: { include: { interviewList: true } }, familyMembers: true },
      orderBy: { candidateCode: 'asc' },
    });
    const ordered = candidateIds.map((id) => candidates.find((candidate) => candidate.id === id)).filter(Boolean) as typeof candidates;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Kesa';
    workbook.created = new Date();
    const ws = workbook.addWorksheet('Danh sach');
    ws.columns = [
      { header: 'STT', width: 6 },
      { header: 'Ma ho so', width: 14 },
      { header: 'Ten tieng Trung', width: 18 },
      { header: 'Ho ten', width: 26 },
      { header: 'Gioi tinh', width: 10 },
      { header: 'Ngay sinh', width: 14 },
      { header: 'Tuoi', width: 8 },
      { header: 'Chieu cao', width: 10 },
      { header: 'Can nang', width: 10 },
      { header: 'Hoc van', width: 14 },
      { header: 'Hon nhan', width: 14 },
      { header: 'Kinh nghiem', width: 55 },
      { header: 'Ghi chu', width: 24 },
    ];
    ws.getRow(1).font = { bold: true };
    ordered.forEach((candidate, index) => {
      ws.addRow([
        index + 1,
        candidate.candidateCode || '',
        candidate.chineseName || '',
        candidate.vietnameseName || '',
        candidate.gender || '',
        candidate.dateOfBirth || '',
        candidate.age || '',
        candidate.height || '',
        candidate.weight || '',
        candidate.education || '',
        candidate.maritalStatus || '',
        [candidate.domesticExperience, candidate.overseasExperience].filter(Boolean).join('\n'),
        candidate.note || '',
      ]);
    });
    ws.eachRow((row) => {
      row.eachCell((cell) => {
        cell.alignment = { vertical: 'top', wrapText: true };
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
      });
    });
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const title = typeof body.listTitle === 'string' && body.listTitle.trim() ? body.listTitle.trim() : 'danh-sach';
    return { buffer, filename: `${title.replace(/[^a-zA-Z0-9\u4e00-\u9fff-]+/g, '_')}.xlsx` };
  }

  candidatesCsv(body: Record<string, unknown>) {
    const candidates = Array.isArray(body.candidates) ? body.candidates : [];
    if (!candidates.length) throw new BadRequestException('Danh sach ung vien khong hop le');
    const headers = ['Ho va Ten', 'Gioi tinh', 'Nam sinh', 'So dien thoai', 'Que quan', 'Chieu cao', 'Can nang', 'Kinh nghiem', 'Ghi chu'];
    const rows = [headers.join(',')];
    for (const raw of candidates) {
      const item = raw as Record<string, unknown>;
      rows.push(
        [
          item.fullName,
          item.gender,
          item.birthYear,
          item.phone,
          item.hometown,
          item.height,
          item.weight,
          item.experience,
          item.notes,
        ]
          .map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`)
          .join(','),
      );
    }
    return { buffer: Buffer.from(`\ufeff${rows.join('\n')}`, 'utf-8'), filename: 'danh_sach_lao_dong_kesa.csv' };
  }
}
