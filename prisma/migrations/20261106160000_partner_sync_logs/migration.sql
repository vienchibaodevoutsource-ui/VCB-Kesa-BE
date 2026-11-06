CREATE TABLE "PartnerSyncLog" (
  "id" TEXT NOT NULL,
  "candidateId" TEXT,
  "candidateCode" TEXT,
  "partner" TEXT NOT NULL,
  "projectCode" TEXT NOT NULL,
  "partnerWorkerId" TEXT,
  "status" TEXT NOT NULL,
  "error" TEXT,
  "extras" JSONB NOT NULL DEFAULT '{}',
  "answers" JSONB NOT NULL DEFAULT '{}',
  "sent" JSONB NOT NULL,
  "sentById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PartnerSyncLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PartnerSyncLog_candidateId_createdAt_idx" ON "PartnerSyncLog"("candidateId", "createdAt");

ALTER TABLE "PartnerSyncLog"
ADD CONSTRAINT "PartnerSyncLog_candidateId_fkey"
FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
