export interface PaginatedResponse<T, S = Record<string, number>> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  stats?: S;
}

export function parsePaginationParams(query: Record<string, unknown>) {
  const page = Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1);
  const pageSize = Math.min(5000, Math.max(1, Number.parseInt(String(query.pageSize ?? '10'), 10) || 10));
  const search = String(query.search ?? '').trim();
  return { page, pageSize, search };
}

export function isPaginatedListRequest(query: Record<string, unknown>) {
  return ['page', 'pageSize', 'search'].some((key) => query[key] !== undefined);
}

export function clampPage(page: number, total: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return { page: Math.min(page, totalPages), totalPages };
}
