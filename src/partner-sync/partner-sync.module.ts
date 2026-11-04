import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PartnerApiClient } from './partner-api.client';
import { PartnerSyncController } from './partner-sync.controller';
import { PartnerSyncService } from './partner-sync.service';

@Module({
  imports: [AuthModule],
  controllers: [PartnerSyncController],
  providers: [PartnerSyncService, PartnerApiClient],
})
export class PartnerSyncModule {}
