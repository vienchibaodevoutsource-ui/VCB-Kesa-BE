-- CreateEnum
CREATE TYPE "CandidateStatus" AS ENUM ('DRAFT', 'COMPLETED');

-- AlterTable
ALTER TABLE "Candidate" ADD COLUMN "status" "CandidateStatus" NOT NULL DEFAULT 'COMPLETED';
ALTER TABLE "Candidate" ADD COLUMN "draftSessionId" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "lastSavedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Candidate_status_draftSessionId_idx" ON "Candidate"("status", "draftSessionId");
CREATE INDEX "Candidate_createdByUserId_idx" ON "Candidate"("createdByUserId");
