# FE Migration Notes

Set this in the frontend:

```env
NEXT_PUBLIC_API_URL=http://localhost:4000
```

Use `credentials: 'include'` for all authenticated requests.

## Endpoint mapping

| Old Next route | New Nest route |
| --- | --- |
| `POST /api/auth/login` | `POST /auth/login` |
| `POST /api/auth/logout` | `POST /auth/logout` |
| `GET /api/auth/me` | `GET /auth/me` |
| `GET/POST /api/candidates` | `GET/POST /candidates` |
| `POST /api/candidates/draft` | `POST /candidates/draft` |
| `GET /api/candidates/check-cccd` | `GET /candidates/check-cccd` |
| `GET/PATCH/PUT/DELETE /api/candidates/:id` | `GET/PATCH/PUT/DELETE /candidates/:id` |
| `POST /api/candidates/:id/complete` | `POST /candidates/:id/complete` |
| `GET /api/candidate-code` | `GET /candidate-codes/next` |
| `GET/POST /api/companies` | `GET/POST /companies` |
| `PUT/DELETE /api/companies/:id` | `PATCH/DELETE /companies/:id` |
| `GET/POST /api/users` | `GET/POST /users` |
| `PUT/DELETE /api/users/:id` | `PATCH/DELETE /users/:id` |
| `GET/POST /api/team-codes` | `GET/POST /team-codes` |
| `PATCH/DELETE /api/team-codes/:id` | `PATCH/DELETE /team-codes/:id` |
| `POST /api/translate` | `POST /ai/translate` |
| `POST /api/import-text` | `POST /ai/import-text` |
| `GET /api/deepseek-balance` | `GET /ai/deepseek-balance` |
| `POST /api/upload-image` | `POST /uploads/images` |
| `POST /api/export-docx` | `POST /exports/docx` |
| `POST /api/export-candidates` | `POST /exports/candidates-xlsx` |
| `POST /api/export-excel` | `POST /exports/candidates-csv` |
| `/api/registrations` | `/registrations` |

## Response shape

Most JSON endpoints now return either:

```json
{ "data": {} }
```

or for paginated lists:

```json
{ "data": [], "total": 0, "page": 1, "pageSize": 10, "stats": {} }
```

Errors use:

```json
{ "error": "message", "details": "optional detail" }
```

## Suggested frontend helper

```ts
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

export async function apiFetch(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
  return res;
}
```
