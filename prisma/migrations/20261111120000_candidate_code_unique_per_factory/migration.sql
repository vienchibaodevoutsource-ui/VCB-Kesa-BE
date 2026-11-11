-- Chuyển hồ sơ (nhân bản sang nhà máy khác) giữ nguyên mã hồ sơ gốc → một mã được dùng ở nhiều nhà máy.
-- Thay ràng buộc "mã không trùng toàn hệ thống" bằng "mã không trùng trong cùng nhà máy
-- (hoặc cùng môi giới khi không có nhà máy)". Hồ sơ đã xoá mềm không tính. Số trong mã vẫn lấy từ
-- bộ đếm chung (CandidateCounter) nên hai người khác nhau vẫn không thể nhận cùng mã.
DROP INDEX IF EXISTS "Candidate_candidateCode_key";

CREATE UNIQUE INDEX "Candidate_candidateCode_scope_key"
  ON "Candidate" ("candidateCode", (COALESCE("factoryId", 'broker:' || COALESCE("brokerId", ''))))
  WHERE "candidateCode" IS NOT NULL AND "deletedAt" IS NULL;

-- Tra hồ sơ theo mã (tìm kiếm, bộ đếm) vẫn cần index thường trên cột này.
CREATE INDEX "Candidate_candidateCode_idx" ON "Candidate" ("candidateCode");
