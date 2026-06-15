import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CandidateCodesModule } from '../candidate-codes/candidate-codes.module';
import { FormsModule } from '../forms/forms.module';
import { CandidatesController } from './candidates.controller';
import { CandidatesService } from './candidates.service';

@Module({
  imports: [AuthModule, CandidateCodesModule, FormsModule],
  controllers: [CandidatesController],
  providers: [CandidatesService],
  exports: [CandidatesService],
})
export class CandidatesModule {}
