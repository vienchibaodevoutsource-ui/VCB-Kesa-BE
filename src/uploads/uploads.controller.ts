import { Body, Controller, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '../common/guards/auth.guard';
import { UploadedFile as UploadedFileType } from '../common/types/uploaded-file';
import { UploadsService } from './uploads.service';

@Controller('uploads')
@UseGuards(AuthGuard)
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post('images')
  @UseInterceptors(FileInterceptor('file'))
  async image(@UploadedFile() file: UploadedFileType, @Body() body: Record<string, string>) {
    return { data: await this.uploads.uploadImage(file, body) };
  }
}
