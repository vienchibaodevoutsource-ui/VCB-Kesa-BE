import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PartnerSheetClient } from './partner-sheet.client';
import { PartnerSyncController } from './partner-sync.controller';
import { PartnerSyncService } from './partner-sync.service';

@Module({
  imports: [AuthModule],
  controllers: [PartnerSyncController],
  providers: [PartnerSyncService, PartnerSheetClient],
})
export class PartnerSyncModule {}
