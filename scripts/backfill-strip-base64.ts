/**
 * Backfill 1 lần: dọn ảnh base64 nhúng trong DB (làm phình ~25MB/hồ sơ, đốt egress Supabase).
 * Với mỗi ảnh base64 → upload lên Supabase Storage → thay bằng public URL → ghi lại row.
 * KHÔNG mất ảnh: chỉ ghi đè khi upload thành công; upload lỗi thì giữ nguyên base64.
 *
 * Quét:
 *   - Candidate: avatarUrl, lineImageUrl, limbImages[], scarImages[], tattooImages[], formDataJson (text)
 *   - CandidateFormSnapshot: data (jsonb)
 *
 * Chạy (Node 22, tự nạp .env):
 *   node --env-file=.env -r ts-node/register scripts/backfill-strip-base64.ts            # thực thi
 *   node --env-file=.env -r ts-node/register scripts/backfill-strip-base64.ts --dry-run  # chỉ đếm, không ghi
 *
 * Xử lý từng row một (fetch theo id) để không kéo mọi blob base64 về cùng lúc.
 */
import { PrismaClient } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';
import { sanitizeImageValues } from '../src/common/utils/image-sanitizer';
import { compressImage } from '../src/common/utils/compress-image';

const DRY_RUN = process.argv.includes('--dry-run');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'imageKesa';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Thiếu SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY trong env.');
  process.exit(1);
}

const prisma = new PrismaClient();
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let uploaded = 0;
let uploadFailed = 0;
let bytesMigrated = 0; // tổng byte ảnh base64 sẽ chuyển sang Storage (ước lượng tăng Storage)

const fmtMB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

async function uploadDataUri(dataUri: string, candidateId: string): Promise<string> {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(dataUri.trim());
  if (!match) return dataUri;
  const rawBuffer = Buffer.from(match[2], 'base64');
  // Nén luôn khi backfill: ảnh base64 cũ thường rất nặng, nén giúp Storage không vỡ quota.
  const compressed = await compressImage(rawBuffer);
  const buffer = compressed?.buffer ?? rawBuffer;
  const contentType = compressed?.contentType ?? match[1];
  const ext = compressed?.ext ?? match[1].split('/')[1]?.split('+')[0] ?? 'jpg';
  bytesMigrated += buffer.length; // đo theo dung lượng SAU nén = mức Storage thực tăng

  // DRY-RUN: chỉ đo, KHÔNG đẩy file lên Storage. Trả URL giả (khác chuỗi gốc) để sanitizer
  // vẫn đếm là "đã thay" phục vụ báo cáo; do DRY_RUN không ghi DB nên URL giả không lưu đâu cả.
  if (DRY_RUN) return `dryrun://would-upload/${candidateId}`;

  const path = `backfill/${candidateId}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType, cacheControl: '3600', upsert: false });
  if (error) {
    uploadFailed += 1;
    console.warn(`  ! upload lỗi (giữ base64): ${error.message}`);
    return dataUri;
  }
  uploaded += 1;
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

async function processCandidates() {
  const ids = (await prisma.candidate.findMany({ select: { id: true } })).map((r) => r.id);
  console.log(`\n== Candidate: ${ids.length} hồ sơ ==`);
  let changed = 0;

  for (const id of ids) {
    const c = await prisma.candidate.findUnique({
      where: { id },
      select: {
        id: true,
        avatarUrl: true,
        lineImageUrl: true,
        limbImages: true,
        scarImages: true,
        tattooImages: true,
        formDataJson: true,
      },
    });
    if (!c) continue;

    const cache = new Map<string, string>();
    const stats = { replaced: 0 };
    const upload = (uri: string) => uploadDataUri(uri, c.id);

    const avatarUrl = (await sanitizeImageValues(c.avatarUrl, upload, cache, stats)) as string | null;
    const lineImageUrl = (await sanitizeImageValues(c.lineImageUrl, upload, cache, stats)) as string | null;
    const limbImages = (await sanitizeImageValues(c.limbImages, upload, cache, stats)) as string[];
    const scarImages = (await sanitizeImageValues(c.scarImages, upload, cache, stats)) as string[];
    const tattooImages = (await sanitizeImageValues(c.tattooImages, upload, cache, stats)) as string[];

    let formDataJson = c.formDataJson;
    if (formDataJson) {
      try {
        const parsed = JSON.parse(formDataJson);
        const clean = await sanitizeImageValues(parsed, upload, cache, stats);
        formDataJson = JSON.stringify(clean);
      } catch {
        console.warn(`  ! formDataJson không phải JSON hợp lệ (bỏ qua) candidate=${c.id}`);
      }
    }

    if (stats.replaced === 0) continue;
    changed += 1;
    console.log(`  ~ candidate ${c.id}: thay ${stats.replaced} ảnh base64`);
    if (!DRY_RUN) {
      await prisma.candidate.update({
        where: { id: c.id },
        data: { avatarUrl, lineImageUrl, limbImages, scarImages, tattooImages, formDataJson },
      });
    }
  }
  console.log(`== Candidate xong: ${changed} hồ sơ đổi ==`);
}

async function processSnapshots() {
  const ids = (await prisma.candidateFormSnapshot.findMany({ select: { id: true } })).map((r) => r.id);
  console.log(`\n== CandidateFormSnapshot: ${ids.length} bản ==`);
  let changed = 0;

  for (const id of ids) {
    const snap = await prisma.candidateFormSnapshot.findUnique({
      where: { id },
      select: { id: true, candidateId: true, data: true },
    });
    if (!snap) continue;

    const cache = new Map<string, string>();
    const stats = { replaced: 0 };
    const upload = (uri: string) => uploadDataUri(uri, snap.candidateId);
    const clean = await sanitizeImageValues(snap.data, upload, cache, stats);

    if (stats.replaced === 0) continue;
    changed += 1;
    console.log(`  ~ snapshot ${snap.id} (candidate ${snap.candidateId}): thay ${stats.replaced} ảnh base64`);
    if (!DRY_RUN) {
      await prisma.candidateFormSnapshot.update({
        where: { id: snap.id },
        data: { data: clean as object },
      });
    }
  }
  console.log(`== Snapshot xong: ${changed} bản đổi ==`);
}

async function main() {
  console.log(`Backfill strip base64 → Storage (bucket: ${BUCKET})${DRY_RUN ? ' [DRY-RUN]' : ''}`);
  await processCandidates();
  await processSnapshots();
  console.log(`\nDung lượng base64 (ảnh duy nhất) cần chuyển sang Storage: ~${fmtMB(bytesMigrated)}`);
  console.log('  → Đây là mức Storage sẽ TĂNG. Free tier Storage = 1GB; kiểm tra còn đủ chỗ trước khi chạy thật.');
  if (DRY_RUN) {
    console.log('DRY-RUN: chưa upload / chưa ghi DB. Bỏ cờ --dry-run để chạy thật.');
  } else {
    console.log(`Tổng: upload thành công ${uploaded}, upload lỗi ${uploadFailed}.`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
