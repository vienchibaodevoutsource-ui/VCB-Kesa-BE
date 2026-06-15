import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { UploadedFile } from '../common/types/uploaded-file';

@Injectable()
export class UploadsService {
  constructor(private readonly config: ConfigService) {}

  async uploadImage(file: UploadedFile, body: Record<string, string>) {
    if (!file) throw new BadRequestException('No file provided');
    if (!file.mimetype.startsWith('image/')) throw new BadRequestException('Only image files are allowed');
    if (file.size > 10 * 1024 * 1024) throw new BadRequestException('File too large');

    const supabaseUrl = this.config.get<string>('SUPABASE_URL');
    const serviceRoleKey = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) throw new InternalServerErrorException('Server not configured for uploads');

    const bucket = this.config.get<string>('SUPABASE_STORAGE_BUCKET') || 'imageKesa';
    const type = body.type || 'avatar';
    const candidateId = body.candidateId || 'temp';
    const ext = file.originalname.split('.').pop() || 'jpg';
    const path = `${type}/${candidateId}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
    const { error } = await supabase.storage
      .from(bucket)
      .upload(path, file.buffer, { contentType: file.mimetype, cacheControl: '3600', upsert: false });
    if (error) throw new InternalServerErrorException(error.message);
    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    return { url: data.publicUrl };
  }
}
