ALTER TABLE "Candidate" ADD COLUMN IF NOT EXISTS "teamCode" TEXT;

UPDATE "User" u
SET "teamCode" = NULL
WHERE u."teamCode" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "TeamCode" tc WHERE tc."code" = u."teamCode"
  );

UPDATE "Candidate" c
SET "createdByUserId" = NULL
WHERE c."createdByUserId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "User" u WHERE u."id" = c."createdByUserId"
  );

UPDATE "Candidate" c
SET "teamCode" = u."teamCode"
FROM "User" u
WHERE c."createdByUserId" = u."id"
  AND u."teamCode" IS NOT NULL;

UPDATE "Candidate" c
SET "teamCode" = tc."code"
FROM "TeamCode" tc
WHERE c."teamCode" IS NULL
  AND c."candidateCode" IS NOT NULL
  AND c."candidateCode" LIKE tc."code" || '%';

UPDATE "Candidate" c
SET "teamCode" = NULL
WHERE c."teamCode" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "TeamCode" tc WHERE tc."code" = c."teamCode"
  );

CREATE INDEX IF NOT EXISTS "Candidate_teamCode_idx" ON "Candidate"("teamCode");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'User_teamCode_fkey') THEN
    ALTER TABLE "User"
    ADD CONSTRAINT "User_teamCode_fkey"
    FOREIGN KEY ("teamCode") REFERENCES "TeamCode"("code")
    ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Candidate_createdByUserId_fkey') THEN
    ALTER TABLE "Candidate"
    ADD CONSTRAINT "Candidate_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Candidate_teamCode_fkey') THEN
    ALTER TABLE "Candidate"
    ADD CONSTRAINT "Candidate_teamCode_fkey"
    FOREIGN KEY ("teamCode") REFERENCES "TeamCode"("code")
    ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
