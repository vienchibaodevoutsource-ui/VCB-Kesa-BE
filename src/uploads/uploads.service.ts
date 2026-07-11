import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient, createClient } from '@supabase/supabase-js';
import { compressImage } from '../common/utils/compress-image';
import { UploadedFile } from '../common/types/uploaded-file';

// Chỉ chấp nhận vài loại ảnh thường gặp để tránh lưu file lạ vào Storage.
const DATA_URI_IMAGE_RE = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/;

@Injectable()
export class UploadsService {
  constructor(private readonly config: ConfigService) {}

  /** Có đủ cấu hình để đẩy file lên Supabase Storage không (dev local có thể thiếu key). */
  isConfigured() {
    return Boolean(this.config.get<string>('SUPABASE_URL') && this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY'));
  }

  async uploadImage(file: UploadedFile, body: Record<string, string>) {
    if (!file) throw new BadRequestException('No file provided');
    if (!file.mimetype.startsWith('image/')) throw new BadRequestException('Only image files are allowed');
    if (file.size > 10 * 1024 * 1024) throw new BadRequestException('File too large');
    const url = await this.uploadBuffer(file.buffer, file.mimetype, {
      type: body.type || 'avatar',
      candidateId: body.candidateId || 'temp',
      ext: file.originalname.split('.').pop(),
    });
    return { url };
  }

  /** Giải mã data URI base64 (vd `data:image/png;base64,....`) và đẩy lên Storage, trả về public URL. */
  async uploadDataUri(dataUri: string, opts: { type?: string; candidateId?: string } = {}) {
    const match = DATA_URI_IMAGE_RE.exec(dataUri.trim());
    if (!match) throw new BadRequestException('Not a base64 image data URI');
    const contentType = match[1];
    const buffer = Buffer.from(match[2], 'base64');
    return this.uploadBuffer(buffer, contentType, {
      type: opts.type ?? 'legacy',
      candidateId: opts.candidateId ?? 'temp',
    });
  }

  async uploadBuffer(
    buffer: Buffer,
    contentType: string,
    opts: { type?: string; candidateId?: string; ext?: string } = {},
  ) {
    const { supabase, bucket } = this.client();
    const type = opts.type || 'avatar';
    const candidateId = opts.candidateId || 'temp';

    const compressed = await compressImage(buffer);
    const finalBuffer = compressed?.buffer ?? buffer;
    const finalType = compressed?.contentType ?? contentType;
    const ext = compressed?.ext ?? opts.ext ?? contentType.split('/')[1]?.split('+')[0] ?? 'jpg';

    const path = `${type}/${candidateId}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    const { error } = await supabase.storage
      .from(bucket)
      .upload(path, finalBuffer, { contentType: finalType, cacheControl: '3600', upsert: false });
    if (error) throw new InternalServerErrorException(error.message);
    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    return data.publicUrl;
  }

  /** Xoá các file trong bucket theo public URL (bỏ qua base64 / URL ngoài bucket). Best-effort. */
  async removeByUrls(urls: (string | null | undefined)[]) {
    if (!this.isConfigured()) return;
    const { supabase, bucket } = this.client();
    const marker = `/object/public/${bucket}/`;
    const paths = Array.from(
      new Set(
        urls
          .filter((u): u is string => typeof u === 'string' && u.includes(marker))
          .map((u) => decodeURIComponent(u.slice(u.indexOf(marker) + marker.length).split('?')[0])),
      ),
    );
    if (!paths.length) return;
    const { error } = await supabase.storage.from(bucket).remove(paths);
    if (error) console.warn(`[uploads] removeByUrls lỗi: ${error.message}`);
  }

  private client(): { supabase: SupabaseClient; bucket: string } {
    const supabaseUrl = this.config.get<string>('SUPABASE_URL');
    const serviceRoleKey = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) throw new InternalServerErrorException('Server not configured for uploads');
    const bucket = this.config.get<string>('SUPABASE_STORAGE_BUCKET') || 'imageKesa';
    const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
    return { supabase, bucket };
  }
}
