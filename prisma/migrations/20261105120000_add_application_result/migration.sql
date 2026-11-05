-- Kết quả ứng tuyển + nhân bản hồ sơ sang nhà máy khác
CREATE TYPE "ApplicationResult" AS ENUM ('PENDING', 'PASSED', 'FAILED');

ALTER TABLE "Candidate"
  ADD COLUMN "applicationResult" "ApplicationResult" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "resultNote" TEXT,
  ADD COLUMN "resultAt" TIMESTAMP(3),
  ADD COLUMN "resultById" TEXT,
  ADD COLUMN "resultByName" TEXT,
  ADD COLUMN "sourceCandidateId" TEXT,
  ADD COLUMN "applicantGroupId" TEXT;

CREATE INDEX "Candidate_applicantGroupId_idx" ON "Candidate"("applicantGroupId");
CREATE INDEX "Candidate_applicationResult_idx" ON "Candidate"("applicationResult");
