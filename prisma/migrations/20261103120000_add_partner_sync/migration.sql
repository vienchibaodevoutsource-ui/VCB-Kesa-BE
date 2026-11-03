CREATE TABLE "PartnerSync" (
  "id" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "partner" TEXT NOT NULL,
  "projectCode" TEXT,
  "partnerWorkerId" TEXT,
  "extras" JSONB NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL,
  "lastError" TEXT,
  "lastSentAt" TIMESTAMP(3),
  "lastSentVersion" TIMESTAMP(3),
  "sentById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PartnerSync_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PartnerSync_candidateId_partner_key" ON "PartnerSync"("candidateId", "partner");

ALTER TABLE "PartnerSync"
ADD CONSTRAINT "PartnerSync_candidateId_fkey"
FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
