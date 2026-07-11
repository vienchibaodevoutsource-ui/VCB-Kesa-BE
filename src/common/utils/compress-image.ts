import sharp from 'sharp';

// Nén ảnh trước khi lưu Storage: giảm cả dung lượng lẫn egress ngay từ gốc. Ảnh hồ sơ/minh chứng
// đều là ảnh chụp nên ép JPEG q80, cạnh dài tối đa 1600px là đủ nét để in docx.
export const MAX_DIMENSION = 1600;
export const JPEG_QUALITY = 80;

/** Nén + xoay đúng chiều (EXIF) + resize. Lỗi (không phải ảnh) → trả null để dùng buffer gốc. */
export async function compressImage(
  buffer: Buffer,
): Promise<{ buffer: Buffer; contentType: string; ext: string } | null> {
  try {
    const out = await sharp(buffer)
      .rotate()
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
    return { buffer: out, contentType: 'image/jpeg', ext: 'jpg' };
  } catch {
    return null;
  }
}
