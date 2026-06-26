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
