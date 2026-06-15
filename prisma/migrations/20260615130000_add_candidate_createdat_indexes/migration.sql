-- Tăng tốc danh sách hồ sơ: lọc theo status + sắp xếp theo createdAt desc, và đếm "mới trong 7 ngày"
CREATE INDEX IF NOT EXISTS "Candidate_status_createdAt_idx" ON "Candidate"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "Candidate_createdAt_idx" ON "Candidate"("createdAt");
