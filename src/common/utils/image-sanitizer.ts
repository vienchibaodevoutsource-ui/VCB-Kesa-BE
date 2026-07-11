// Nhận diện chuỗi ảnh base64 nhúng thẳng (data URI). Đây là thứ làm phình DB tới ~25MB/hồ sơ.
// Chỉ bắt data URI ảnh + đủ dài để tránh nhầm với chuỗi text ngắn hợp lệ.
const DATA_URI_IMAGE_RE = /^data:image\/[a-zA-Z0-9.+-]+;base64,/;
const MIN_BASE64_LEN = 256;

export function isBase64Image(value: unknown): value is string {
  return typeof value === 'string' && value.length >= MIN_BASE64_LEN && DATA_URI_IMAGE_RE.test(value.trim());
}

export type ImageUploader = (dataUri: string) => Promise<string>;

/**
 * Đệ quy qua một giá trị JSON (object/array/string), thay mọi ảnh base64 bằng URL Storage
 * thông qua `upload`. Dùng chung cho cả write-time (chặn base64 mới) lẫn backfill (dọn dữ liệu cũ).
 *
 * `cache` gom các base64 trùng nhau trong cùng một hồ sơ (vd avatar vừa nằm ở cột vừa nằm
 * trong snapshot) để chỉ upload một lần. `stats.replaced` đếm số ảnh đã thay để caller biết
 * có thay đổi hay không (bỏ qua ghi DB nếu không đổi).
 */
export async function sanitizeImageValues(
  value: unknown,
  upload: ImageUploader,
  cache: Map<string, string> = new Map(),
  stats: { replaced: number } = { replaced: 0 },
): Promise<unknown> {
  if (isBase64Image(value)) {
    const key = value.trim();
    const cached = cache.get(key);
    if (cached) {
      stats.replaced += 1;
      return cached;
    }
    const url = await upload(key);
    // upload thất bại (caller trả lại nguyên base64) thì không coi là đã thay.
    if (url !== key) {
      cache.set(key, url);
      stats.replaced += 1;
    }
    return url;
  }

  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
      out[i] = await sanitizeImageValues(value[i], upload, cache, stats);
    }
    return out;
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = await sanitizeImageValues(v, upload, cache, stats);
    }
    return out;
  }

  return value;
}
