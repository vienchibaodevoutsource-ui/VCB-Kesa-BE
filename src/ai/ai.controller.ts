import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { AiService } from './ai.service';
import { ImportTextDto, TranslateDto } from './dto';

@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Post('translate')
  @UseGuards(AuthGuard)
  translate(@Body() dto: TranslateDto) {
    return this.ai.translate(dto.texts, dto.targetLang || 'zh');
  }

  @Post('import-text')
  importText(@Body() dto: ImportTextDto) {
    return { data: this.ai.parseRawText(dto.text) };
  }

  @Get('deepseek-balance')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  balance() {
    return this.ai.getDeepSeekBalance();
  }
}
