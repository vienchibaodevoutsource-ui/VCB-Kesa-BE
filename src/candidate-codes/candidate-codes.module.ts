import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CandidateCodesController } from './candidate-codes.controller';
import { CandidateCodesService } from './candidate-codes.service';

@Module({
  imports: [AuthModule],
  controllers: [CandidateCodesController],
  providers: [CandidateCodesService],
  exports: [CandidateCodesService],
})
export class CandidateCodesModule {}
