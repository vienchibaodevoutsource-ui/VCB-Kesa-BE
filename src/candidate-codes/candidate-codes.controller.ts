import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { AuthUser } from '../common/types';
import { CandidateCodesService } from './candidate-codes.service';

@Controller('candidate-codes')
@UseGuards(AuthGuard)
export class CandidateCodesController {
  constructor(private readonly codes: CandidateCodesService) {}

  @Get('next')
  async next(@CurrentUser() user: AuthUser) {
    return {
      data: {
        nextNumber: await this.codes.getNextGlobalCodeNumber(),
        teamCode: user.teamCode?.trim().toUpperCase() || null,
      },
    };
  }
}
