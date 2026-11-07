-- Xoá mềm hồ sơ: bấm Xoá chỉ đánh dấu deletedAt, Admin khôi phục được từ "Thùng rác".
ALTER TABLE "Candidate"
  ADD COLUMN "deletedAt" TIMESTAMP(3),
  ADD COLUMN "deletedById" TEXT,
  ADD COLUMN "deletedByName" TEXT;

CREATE INDEX "Candidate_deletedAt_idx" ON "Candidate"("deletedAt");
