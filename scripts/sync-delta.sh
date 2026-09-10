#!/usr/bin/env bash
# Đồng bộ phần dữ liệu phát sinh từ project nguồn sang project đích.
# Chạy lại được nhiều lần. Dùng khi nguồn vẫn đang có người dùng thật.
#
#   ./scripts/sync-delta.sh <thư-mục-làm-việc>
#
# Thư mục làm việc giữ sổ theo dõi ledger.jsonl và ledger2.jsonl giữa các lần chạy.
set -euo pipefail

WORK="${1:?Thiếu thư mục làm việc}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$WORK"
export PGCONNECT_TIMEOUT=60

SRC="${SRC_DATABASE_URL:?Thiếu SRC_DATABASE_URL}"
DST="${DST_DATABASE_URL:?Thiếu DST_DATABASE_URL}"

echo "== 1. Lấy danh sách ảnh mới nhất từ nguồn =="
psql "$SRC" -tAF$'\t' -c "select name, coalesce(metadata->>'mimetype','image/jpeg'), coalesce(metadata->>'size','0')
  from storage.objects where bucket_id='imageKesa' order by name;" > "$WORK/objects.tsv"
echo "   $(wc -l < "$WORK/objects.tsv" | tr -d ' ') ảnh trên nguồn"

echo "== 2. Đẩy ảnh còn thiếu lên Cloudinary =="
for pair in ".env.migrate:ledger.jsonl" ".env.migrate2:ledger2.jsonl"; do
  env_file="${pair%%:*}"; ledger="${pair##*:}"
  [ -f "$HERE/$env_file" ] || { echo "   bỏ qua $env_file (không có)"; continue; }
  ( set -a; . "$HERE/$env_file"; set +a
    echo "   -> $CLOUDINARY_CLOUD_NAME"
    node "$HERE/scripts/copy-images-to-cloudinary.mjs" "$WORK/objects.tsv" "$WORK/$ledger" | tail -3 ) || true
done

echo "== 3. Tìm ứng viên mới hoặc bị sửa =="
psql "$SRC" -tAF'|' -c 'select id, "updatedAt" from public."Candidate";' | sort -t'|' -k1,1 > "$WORK/s_c.txt"
psql "$DST" -tAF'|' -c 'select id, "updatedAt" from public."Candidate";' | sort -t'|' -k1,1 > "$WORK/d_c.txt"
{ join -t'|' -v1 "$WORK/s_c.txt" "$WORK/d_c.txt" | cut -d'|' -f1
  join -t'|' "$WORK/s_c.txt" "$WORK/d_c.txt" | awk -F'|' '$2!=$3 {print $1}'
} | sort -u > "$WORK/changed.txt"
N=$(wc -l < "$WORK/changed.txt" | tr -d ' ')
echo "   $N ứng viên cần đồng bộ"

if [ "$N" -gt 0 ]; then
  IDS=$(awk '{printf "%s'\''%s'\''", (NR>1?",":""), $0}' "$WORK/changed.txt")
  psql "$SRC" -c "\copy (select * from public.\"Candidate\" where id in ($IDS)) to '$WORK/dl_cand.csv' with (format csv)" >/dev/null
  psql "$SRC" -c "\copy (select * from public.\"FamilyMember\" where \"candidateId\" in ($IDS)) to '$WORK/dl_fm.csv' with (format csv)" >/dev/null
  psql "$SRC" -c "\copy (select * from public.\"CandidateFormSnapshot\" where \"candidateId\" in ($IDS)) to '$WORK/dl_snap.csv' with (format csv)" >/dev/null
  # Xoá rồi nạp lại: khoá ngoại có ON DELETE CASCADE nên người thân và phiếu đi theo.
  psql "$DST" -v ON_ERROR_STOP=1 <<SQL
begin;
delete from public."Candidate" where id in ($IDS);
\copy public."Candidate" from '$WORK/dl_cand.csv' with (format csv)
\copy public."FamilyMember" from '$WORK/dl_fm.csv' with (format csv)
\copy public."CandidateFormSnapshot" from '$WORK/dl_snap.csv' with (format csv)
commit;
SQL
fi

echo "== 4. Đổi URL ảnh sang Cloudinary =="
python3 - "$WORK/ledger.jsonl" "$WORK/map.csv" <<'PY'
import json, sys, csv
rows = [(d['old_url'], d['secure_url'])
        for d in (json.loads(l) for l in open(sys.argv[1]) if l.strip())]
csv.writer(open(sys.argv[2], 'w', newline='')).writerows(rows)
print(f"   bảng ánh xạ: {len(rows)} cặp")
PY
psql "$DST" -v ON_ERROR_STOP=1 <<SQL
drop table if exists _img_map;
create table _img_map (old_url text primary key, new_url text not null);
\copy _img_map from '$WORK/map.csv' with (format csv)
SQL
psql "$DST" -v ON_ERROR_STOP=1 -f "$HERE/scripts/rewrite-image-urls.sql"
psql "$DST" -c "drop table if exists _img_map;" >/dev/null

echo "== 5. Kiểm chứng =="
for T in Candidate CandidateFormSnapshot FamilyMember Company User TeamCode CandidateCounter; do
  s=$(psql "$SRC" -tAc "select count(*) from public.\"$T\";")
  d=$(psql "$DST" -tAc "select count(*) from public.\"$T\";")
  printf "   %-24s nguồn=%-6s đích=%-6s %s\n" "$T" "$s" "$d" "$([ "$s" = "$d" ] && echo OK || echo 'LỆCH')"
done
echo "Xong."
