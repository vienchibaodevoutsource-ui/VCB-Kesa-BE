import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { CandidateCodesModule } from '../candidate-codes/candidate-codes.module';
import { CandidatesModule } from '../candidates/candidates.module';
import { CompaniesModule } from '../companies/companies.module';
import { ExportsModule } from '../exports/exports.module';
import { FormsModule } from '../forms/forms.module';
import { RegistrationsModule } from '../registrations/registrations.module';
import { TeamCodesModule } from '../team-codes/team-codes.module';
import { UploadsModule } from '../uploads/uploads.module';
import { UsersModule } from '../users/users.module';
import { CompatibilityController } from './compatibility.controller';

@Module({
  imports: [
    AuthModule,
    UsersModule,
    TeamCodesModule,
    CompaniesModule,
    CandidateCodesModule,
    CandidatesModule,
    AiModule,
    UploadsModule,
    ExportsModule,
    FormsModule,
    RegistrationsModule,
  ],
  controllers: [CompatibilityController],
})
export class CompatibilityModule {}
