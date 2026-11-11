// Bỏ dấu tiếng Việt + chữ thường để tìm kiếm không phân biệt dấu/hoa-thường.
export function normalizeSearch(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Chuỗi đem index cho cột nameSearch của Candidate.
export function buildCandidateNameSearch(parts: Array<string | null | undefined>): string {
  return normalizeSearch(parts.filter(Boolean).join(' '));
}

// Dấu thanh tiếng Việt (dạng tổ hợp NFD): huyền, sắc, ngã, hỏi, nặng. Dấu mũ/trăng/móc (â ă ơ ư) KHÔNG nằm đây.
const VN_TONE_MARKS = /[̣̀́̃̉]/g;

/**
 * Khoá so trùng họ tên: GIỮ dấu nhưng không phụ thuộc cách gõ.
 * - NFC/NFD (chữ copy từ Zalo/PDF) → cùng một khoá.
 * - Kiểu đặt dấu cũ/mới ("Hoà"/"Hòa", "Thuỷ"/"Thủy") → cùng một khoá: dấu thanh của mỗi tiếng
 *   được tách ra và gắn về cuối tiếng, nên vị trí đặt dấu không còn ảnh hưởng.
 * - Không phân biệt hoa/thường, gộp khoảng trắng.
 */
export function personNameKey(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
    .normalize('NFD')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const tones = word.match(VN_TONE_MARKS)?.join('') ?? '';
      return (word.replace(VN_TONE_MARKS, '') + tones).normalize('NFC');
    })
    .join(' ');
}

/**
 * Các cách ghi cùng một ngày sinh đang có trong DB, để so trùng không lọt vì khác định dạng.
 * Nhận dd/mm/yyyy, d/m/yyyy, dd-mm-yyyy, yyyy-mm-dd; trả về ['19/03/2006', '19/3/2006', '2006-03-19', ...].
 * Không nhận ra định dạng → chỉ trả lại chính chuỗi đó.
 */
export function dobVariants(input: unknown): string[] {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return [];
  let d: number, m: number, y: string;
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(raw);
  const ymd = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
  if (dmy) [d, m, y] = [Number(dmy[1]), Number(dmy[2]), dmy[3]];
  else if (ymd) [d, m, y] = [Number(ymd[3]), Number(ymd[2]), ymd[1]];
  else return [raw];
  if (d < 1 || d > 31 || m < 1 || m > 12) return [raw];
  const dd = String(d).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return Array.from(new Set([raw, `${dd}/${mm}/${y}`, `${d}/${m}/${y}`, `${dd}-${mm}-${y}`, `${y}-${mm}-${dd}`]));
}
