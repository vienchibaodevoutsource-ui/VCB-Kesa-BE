import { Body, Controller, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AuthGuard } from '../common/guards/auth.guard';
import { ExportsService } from './exports.service';

@Controller('exports')
@UseGuards(AuthGuard)
export class ExportsController {
  constructor(private readonly exportsService: ExportsService) {}

  @Post('docx')
  async docx(@Body() body: Record<string, unknown>, @Res() response: Response) {
    const buffer = await this.exportsService.htmlToDocx(body);
    response
      .status(200)
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': 'attachment; filename="document.docx"',
      })
      .send(buffer);
  }

  @Post('candidates-xlsx')
  async candidatesXlsx(@Body() body: Record<string, unknown>, @Res() response: Response) {
    const { buffer, filename } = await this.exportsService.candidatesXlsx(body);
    response
      .status(200)
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      })
      .send(buffer);
  }

  @Post('candidates-csv')
  async candidatesCsv(@Body() body: Record<string, unknown>, @Res() response: Response) {
    const { buffer, filename } = this.exportsService.candidatesCsv(body);
    response
      .status(200)
      .set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      })
      .send(buffer);
  }
}
