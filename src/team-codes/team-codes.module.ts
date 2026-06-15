import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TeamCodesController } from './team-codes.controller';
import { TeamCodesService } from './team-codes.service';

@Module({
  imports: [AuthModule],
  controllers: [TeamCodesController],
  providers: [TeamCodesService],
  exports: [TeamCodesService],
})
export class TeamCodesModule {}
