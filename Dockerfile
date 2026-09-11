FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:22-alpine AS build
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/templates ./templates
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
EXPOSE 4000
# Dạng JSON để tín hiệu dừng của Docker tới thẳng tiến trình, không bị shell nuốt.
# exec cho node thay chỗ shell, nhờ đó SIGTERM tới đúng ứng dụng và nó đóng kết nối tử tế.
CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/main.js"]
