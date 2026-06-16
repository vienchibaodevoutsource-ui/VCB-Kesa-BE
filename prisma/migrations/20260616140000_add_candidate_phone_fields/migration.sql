-- Thêm SĐT người lao động và SĐT người thân vào hồ sơ ứng viên
ALTER TABLE "Candidate" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "Candidate" ADD COLUMN IF NOT EXISTS "relativePhone" TEXT;
