export function normalizeTeamCode(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input.trim().toUpperCase();
}

export function validateTeamCodeFormat(code: string): string | null {
  if (!code) return 'Team Code khong duoc de trong';
  if (!/^[A-Z0-9-]{2,16}$/.test(code)) {
    return 'Team Code chi gom 2-16 ky tu: chu in hoa, so hoac dau gach ngang (A-Z, 0-9, -)';
  }
  return null;
}
