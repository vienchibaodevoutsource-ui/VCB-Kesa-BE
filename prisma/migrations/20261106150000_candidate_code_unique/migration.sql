-- Mã hồ sơ không được trùng. Đã quét 2026-11-06: 0 mã trùng, 0 mã rỗng.
-- NULL (hồ sơ nháp chưa có mã) được phép lặp lại — Postgres không coi NULL là trùng nhau.
CREATE UNIQUE INDEX "Candidate_candidateCode_key" ON "Candidate"("candidateCode");
