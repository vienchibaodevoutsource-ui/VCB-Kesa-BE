UPDATE "Candidate" c
SET "teamCode" = (
  SELECT tc."code"
  FROM "TeamCode" tc
  WHERE c."candidateCode" IS NOT NULL
    AND c."candidateCode" LIKE tc."code" || '%'
  ORDER BY length(tc."code") DESC
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1
  FROM "TeamCode" tc
  WHERE c."candidateCode" IS NOT NULL
    AND c."candidateCode" LIKE tc."code" || '%'
);
