// Copy ảnh từ Supabase Storage (bucket public) sang Cloudinary.
// Cloudinary tự tải file từ URL public của Supabase nên không kéo byte qua máy chạy script.
// Chạy lại được nhiều lần: file sổ theo dõi ghi từng ảnh đã xong, lần sau bỏ qua.
//
// Dùng:
//   node scripts/copy-images-to-cloudinary.mjs <danh-sách.tsv> <sổ-theo-dõi.jsonl>
//
// Biến môi trường bắt buộc:
//   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
// Tuỳ chọn: SOURCE_PUBLIC_BASE (mặc định trỏ về bucket imageKesa của project nguồn)

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';

const [listPath, ledgerPath] = process.argv.slice(2);
if (!listPath || !ledgerPath) {
  console.error('Thiếu tham số: <danh-sách.tsv> <sổ-theo-dõi.jsonl>');
  process.exit(1);
}

const CLOUD = process.env.CLOUDINARY_CLOUD_NAME;
const KEY = process.env.CLOUDINARY_API_KEY;
const SECRET = process.env.CLOUDINARY_API_SECRET;
if (!CLOUD || !KEY || !SECRET) {
  console.error('Thiếu CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET.');
  process.exit(1);
}

const PUBLIC_BASE =
  process.env.SOURCE_PUBLIC_BASE ||
  'https://nzlcqizlpnrikshajyhe.supabase.co/storage/v1/object/public/imageKesa';
const PREFIX = process.env.CLOUDINARY_FOLDER_PREFIX || 'kesa';
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
const MAX_RETRY = 3;

/** Cloudinary ký bằng SHA1 của các tham số đã sắp xếp, nối thêm api_secret ở cuối. */
function sign(params) {
  const base = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return createHash('sha1').update(base + SECRET).digest('hex');
}

/** Bỏ phần đuôi file: Cloudinary tự suy ra định dạng và gắn lại khi trả URL. */
function toPublicId(name) {
  const noExt = name.replace(/\.[A-Za-z0-9]+$/, '');
  return `${PREFIX}/${noExt}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function uploadOne(name) {
  const publicId = toPublicId(name);
  const timestamp = Math.floor(Date.now() / 1000);
  const signed = { public_id: publicId, timestamp };
  const body = new URLSearchParams({
    ...signed,
    signature: sign(signed),
    api_key: KEY,
    file: `${PUBLIC_BASE}/${name}`,
  });

  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

const done = new Set();
if (existsSync(ledgerPath)) {
  for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      done.add(JSON.parse(line).name);
    } catch {
      /* dòng hỏng thì bỏ qua, ảnh đó sẽ được đẩy lại */
    }
  }
}

const all = readFileSync(listPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [name, mimetype, size] = l.split('\t');
    return { name, mimetype, size: Number(size) };
  });
const todo = all.filter((o) => !done.has(o.name));

console.log(`Tổng ${all.length} ảnh, đã xong ${done.size}, còn ${todo.length}. Chạy ${CONCURRENCY} luồng.`);

let ok = 0;
let failed = 0;
const failures = [];
let cursor = 0;

async function worker() {
  while (cursor < todo.length) {
    const item = todo[cursor++];
    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      try {
        const r = await uploadOne(item.name);
        appendFileSync(
          ledgerPath,
          JSON.stringify({
            name: item.name,
            old_url: `${PUBLIC_BASE}/${item.name}`,
            public_id: r.public_id,
            secure_url: r.secure_url,
            bytes: r.bytes,
            format: r.format,
          }) + '\n',
        );
        ok++;
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        // 420 và 429 là bị chặn tốc độ, lùi lâu hơn.
        const backoff = e.status === 420 || e.status === 429 ? 15000 * attempt : 1000 * attempt;
        if (attempt < MAX_RETRY) await sleep(backoff);
      }
    }
    if (lastErr) {
      failed++;
      failures.push({ name: item.name, error: lastErr.message });
      console.error(`  LỖI ${item.name}: ${lastErr.message}`);
    }
    const seen = ok + failed;
    if (seen % 100 === 0) console.log(`  ...${seen}/${todo.length} (thành công ${ok}, lỗi ${failed})`);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(`\nXong. Thành công ${ok}, lỗi ${failed}. Sổ theo dõi: ${ledgerPath}`);
if (failures.length) {
  console.log('Các ảnh lỗi (chạy lại script để thử tiếp):');
  for (const f of failures.slice(0, 20)) console.log(`  ${f.name} -> ${f.error}`);
  process.exit(1);
}
