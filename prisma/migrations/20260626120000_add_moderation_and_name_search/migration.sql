-- AlterTable: User moderation capability
ALTER TABLE "User" ADD COLUMN     "canModerate" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: Candidate moderation audit + normalized search
ALTER TABLE "Candidate" ADD COLUMN     "verifiedById" TEXT,
ADD COLUMN     "verifiedByName" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "nameSearch" TEXT;

-- CreateIndex
CREATE INDEX "Candidate_nameSearch_idx" ON "Candidate"("nameSearch");
