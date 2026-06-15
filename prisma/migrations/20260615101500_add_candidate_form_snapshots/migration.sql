CREATE TABLE "CandidateFormSnapshot" (
  "id" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "formType" TEXT,
  "data" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CandidateFormSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CandidateFormSnapshot_candidateId_key" ON "CandidateFormSnapshot"("candidateId");
CREATE INDEX "CandidateFormSnapshot_formType_idx" ON "CandidateFormSnapshot"("formType");

ALTER TABLE "CandidateFormSnapshot"
ADD CONSTRAINT "CandidateFormSnapshot_candidateId_fkey"
FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "CandidateFormSnapshot" ("id", "candidateId", "formType", "data", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  "id",
  COALESCE(NULLIF(("formDataJson"::jsonb ->> 'formType'), ''), NULLIF(("formDataJson"::jsonb ->> 'company'), '')),
  "formDataJson"::jsonb,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Candidate"
WHERE "formDataJson" IS NOT NULL
  AND btrim("formDataJson") <> ''
  AND "formDataJson" IS JSON;
