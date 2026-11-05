-- Bỏ kết quả ứng tuyển (không dùng nữa) → chuyển hồ sơ kèm lý do + liên kết hồ sơ nguồn
DROP INDEX IF EXISTS "Candidate_applicationResult_idx";

ALTER TABLE "Candidate"
  DROP COLUMN "applicationResult",
  DROP COLUMN "resultNote",
  DROP COLUMN "resultAt",
  DROP COLUMN "resultById",
  DROP COLUMN "resultByName",
  ADD COLUMN "transferReason" TEXT;

DROP TYPE "ApplicationResult";

-- Liên kết trỏ tới hồ sơ đã xoá thì bỏ, để thêm khoá ngoại không lỗi
UPDATE "Candidate" c SET "sourceCandidateId" = NULL
WHERE c."sourceCandidateId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Candidate" s WHERE s."id" = c."sourceCandidateId");

CREATE INDEX "Candidate_sourceCandidateId_idx" ON "Candidate"("sourceCandidateId");

ALTER TABLE "Candidate"
ADD CONSTRAINT "Candidate_sourceCandidateId_fkey"
FOREIGN KEY ("sourceCandidateId") REFERENCES "Candidate"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
