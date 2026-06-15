# KESA Backend

NestJS backend split out from the Next.js frontend.

## Local setup

```bash
npm install
copy .env.example .env
npm run prisma:generate
npm run dev
```

Set the frontend to call this API:

```env
NEXT_PUBLIC_API_URL=http://localhost:4000
```

All browser requests that need auth must include credentials.

## Build

```bash
npm run build
```

## Deploy notes

- Render/Railway/Fly should run `npm run build` and then `npm start`.
- Set `FRONTEND_ORIGIN` to the exact frontend origin. For multiple origins, use comma-separated values.
- In production, auth cookies are emitted as `SameSite=None; Secure`, so HTTPS is required.
- Run `npm run prisma:deploy` before starting if new migrations are added.
- The backend schema adds a `Registration` table because the frontend already calls registration APIs but the old Next routes were missing.
