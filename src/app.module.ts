import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiModule } from './ai/ai.module';
import { AuthModule } from './auth/auth.module';
import { CandidateCodesModule } from './candidate-codes/candidate-codes.module';
import { CandidatesModule } from './candidates/candidates.module';
import { CompaniesModule } from './companies/companies.module';
import { CompatibilityModule } from './compatibility/compatibility.module';
import { ExportsModule } from './exports/exports.module';
import { FormsModule } from './forms/forms.module';
import { PrismaModule } from './prisma/prisma.module';
import { RegistrationsModule } from './registrations/registrations.module';
import { TeamCodesModule } from './team-codes/team-codes.module';
import { UploadsModule } from './uploads/uploads.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    UsersModule,
    TeamCodesModule,
    CompaniesModule,
    CandidateCodesModule,
    CandidatesModule,
    AiModule,
    UploadsModule,
    FormsModule,
    ExportsModule,
    RegistrationsModule,
    CompatibilityModule,
  ],
})
export class AppModule {}
