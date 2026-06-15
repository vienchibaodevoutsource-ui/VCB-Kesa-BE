import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FormsModule } from '../forms/forms.module';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';

@Module({
  imports: [AuthModule, FormsModule],
  controllers: [ExportsController],
  providers: [ExportsService],
  exports: [ExportsService],
})
export class ExportsModule {}
