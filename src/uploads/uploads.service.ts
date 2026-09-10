import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadApiResponse, v2 as cloudinary } from 'cloudinary';
import { compressImage } from '../common/utils/compress-image';
import { UploadedFile } from '../common/types/uploaded-file';

// Chỉ chấp nhận vài loại ảnh thường gặp để tránh lưu file lạ vào Storage.
const DATA_URI_IMAGE_RE = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/;

// Ảnh nằm dưới một tiền tố chung để tách khỏi phần còn lại của tài khoản Cloudinary.
const DEFAULT_FOLDER_PREFIX = 'kesa';

// Đoạn biến đổi ảnh trong URL Cloudinary, ví dụ f_auto,q_auto hoặc w_500,c_fill.
const TRANSFORM_SEGMENT_RE = /^[a-z]{1,3}_[^/]*$/;
const VERSION_SEGMENT_RE = /^v\d+$/;

@Injectable()
export class UploadsService {
  private configured = false;

  constructor(private readonly config: ConfigService) {}

  /** Có đủ cấu hình để đẩy file lên Cloudinary không (dev local có thể thiếu key). */
  isConfigured() {
    return Boolean(
      this.config.get<string>('CLOUDINARY_CLOUD_NAME') &&
        this.config.get<string>('CLOUDINARY_API_KEY') &&
        this.config.get<string>('CLOUDINARY_API_SECRET'),
    );
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

  /** Giải mã data URI base64 (vd `data:image/png;base64,....`) và đẩy lên Cloudinary, trả về public URL. */
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
    this.ensureConfigured();
    const type = opts.type || 'avatar';
    const candidateId = opts.candidateId || 'temp';

    const compressed = await compressImage(buffer);
    const finalBuffer = compressed?.buffer ?? buffer;

    // public_id không mang đuôi file: Cloudinary tự suy ra định dạng và gắn lại khi trả URL.
    const publicId = `${this.folderPrefix()}/${type}/${candidateId}/${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const result = await this.uploadToCloudinary(finalBuffer, publicId);
    return result.secure_url;
  }

  /** Xoá một ảnh theo public URL. Trả về việc có thực sự xoá gì không (URL lạ thì bỏ qua). */
  async removeByUrl(url?: string | null) {
    if (!url) throw new BadRequestException('No url provided');
    if (!this.isConfigured()) return { deleted: false, skipped: true };
    const publicId = this.toPublicId(url, this.config.get<string>('CLOUDINARY_CLOUD_NAME'));
    // URL cũ của Supabase hoặc ảnh ngoài tài khoản: không có gì để xoá, coi như xong.
    if (!publicId) return { deleted: false, skipped: true };
    await this.removeByUrls([url]);
    return { deleted: true };
  }

  /** Xoá các ảnh trên Cloudinary theo public URL (bỏ qua base64 / URL ngoài Cloudinary). Best-effort. */
  async removeByUrls(urls: (string | null | undefined)[]) {
    if (!this.isConfigured()) return;
    const cloudName = this.config.get<string>('CLOUDINARY_CLOUD_NAME');
    const publicIds = Array.from(
      new Set(
        urls
          .map((u) => (typeof u === 'string' ? this.toPublicId(u, cloudName) : null))
          .filter((id): id is string => Boolean(id)),
      ),
    );
    if (!publicIds.length) return;
    this.configure();
    // delete_resources nhận tối đa 100 public_id mỗi lượt.
    for (let i = 0; i < publicIds.length; i += 100) {
      const batch = publicIds.slice(i, i + 100);
      try {
        await cloudinary.api.delete_resources(batch, { resource_type: 'image', type: 'upload' });
      } catch (err) {
        console.warn(`[uploads] removeByUrls lỗi: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Tách public_id từ một secure URL của Cloudinary. Trả null nếu URL không thuộc tài khoản đang dùng.
   * URL có dạng /<cloud>/image/upload/<biến-đổi>/<v123>/<public_id>.<đuôi>, hai phần giữa đều tuỳ chọn.
   */
  private toPublicId(url: string, cloudName?: string): string | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.hostname !== 'res.cloudinary.com') return null;

    const parts = parsed.pathname.replace(/^\//, '').split('/');
    const [cloud, resourceType, deliveryType, ...rest] = parts;
    if (cloudName && cloud !== cloudName) return null;
    if (!['image', 'video', 'raw'].includes(resourceType) || deliveryType !== 'upload') return null;

    // Có đoạn phiên bản thì mọi thứ trước nó là biến đổi ảnh; không có thì bóc theo hình dạng.
    const versionAt = rest.findIndex((p) => VERSION_SEGMENT_RE.test(p));
    let idParts: string[];
    if (versionAt !== -1) {
      idParts = rest.slice(versionAt + 1);
    } else {
      let i = 0;
      while (i < rest.length - 1 && TRANSFORM_SEGMENT_RE.test(rest[i])) i++;
      idParts = rest.slice(i);
    }
    if (!idParts.length) return null;

    const joined = idParts.join('/').replace(/\.[A-Za-z0-9]+$/, '');
    return joined ? decodeURIComponent(joined) : null;
  }

  private folderPrefix() {
    return this.config.get<string>('CLOUDINARY_FOLDER_PREFIX') || DEFAULT_FOLDER_PREFIX;
  }

  private ensureConfigured() {
    if (!this.isConfigured()) throw new InternalServerErrorException('Server not configured for uploads');
    this.configure();
  }

  private configure() {
    if (this.configured) return;
    cloudinary.config({
      cloud_name: this.config.get<string>('CLOUDINARY_CLOUD_NAME'),
      api_key: this.config.get<string>('CLOUDINARY_API_KEY'),
      api_secret: this.config.get<string>('CLOUDINARY_API_SECRET'),
      secure: true,
    });
    this.configured = true;
  }

  private uploadToCloudinary(buffer: Buffer, publicId: string): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { public_id: publicId, resource_type: 'image', overwrite: false },
        (error, result) => {
          if (error) return reject(new InternalServerErrorException(error.message));
          if (!result) return reject(new InternalServerErrorException('Cloudinary trả về kết quả rỗng'));
          resolve(result);
        },
      );
      stream.end(buffer);
    });
  }
}
