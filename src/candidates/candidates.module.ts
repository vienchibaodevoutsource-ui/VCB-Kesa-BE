import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CandidateCodesModule } from '../candidate-codes/candidate-codes.module';
import { CandidatesController } from './candidates.controller';
import { CandidatesService } from './candidates.service';

@Module({
  imports: [AuthModule, CandidateCodesModule],
  controllers: [CandidatesController],
  providers: [CandidatesService],
  exports: [CandidatesService],
})
export class CandidatesModule {}
