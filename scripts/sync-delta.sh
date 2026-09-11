#!/usr/bin/env bash
# Đồng bộ phần dữ liệu phát sinh từ project nguồn sang project đích.
# Chạy lại được nhiều lần. Dùng khi nguồn vẫn đang có người dùng thật.
#
#   SRC_DATABASE_URL=... DST_DATABASE_URL=... ./scripts/sync-delta.sh <thư-mục-làm-việc>
#
# Thư mục làm việc giữ sổ theo dõi ledger.jsonl và ledger2.jsonl giữa các lần chạy,
# nhờ đó ảnh đã đẩy lên Cloudinary lần trước sẽ được bỏ qua.
set -euo pipefail

WORK="${1:?Thiếu thư mục làm việc}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$WORK"
export PGCONNECT_TIMEOUT=60

SRC="${SRC_DATABASE_URL:?Thiếu SRC_DATABASE_URL}"
DST="${DST_DATABASE_URL:?Thiếu DST_DATABASE_URL}"

# Bảng tham chiếu: đồng bộ trước vì chúng là đích của khoá ngoại từ Candidate.
REF_TABLES=(Company User TeamCode CandidateCounter)

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
    node "$HERE/scripts/copy-images-to-cloudinary.mjs" "$WORK/objects.tsv" "$WORK/$ledger" | tail -2 ) || true
done

echo "== 3. Đồng bộ bảng tham chiếu =="
for T in "${REF_TABLES[@]}"; do
  cols=$(psql "$DST" -tAc "select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    from information_schema.columns where table_schema='public' and table_name='$T';")
  sets=$(psql "$DST" -tAc "select string_agg(format('%I = excluded.%I', column_name, column_name), ', ' order by ordinal_position)
    filter (where column_name <> 'id')
    from information_schema.columns where table_schema='public' and table_name='$T';")
  psql "$SRC" -c "\copy (select * from public.\"$T\") to '$WORK/ref_$T.csv' with (format csv)" > /dev/null

  {
    echo "begin;"
    echo "create temp table _stg (like public.\"$T\" including defaults);"
    echo "\\copy _stg from '$WORK/ref_$T.csv' with (format csv)"
    echo "insert into public.\"$T\" ($cols) select $cols from _stg on conflict (id) do update set $sets;"
    echo "delete from public.\"$T\" t where not exists (select 1 from _stg s where s.id = t.id);"
    echo "commit;"
  } > "$WORK/ref_$T.sql"
  psql "$DST" -v ON_ERROR_STOP=1 -q -f "$WORK/ref_$T.sql" > /dev/null

  s=$(psql "$SRC" -tAc "select count(*) from public.\"$T\";")
  d=$(psql "$DST" -tAc "select count(*) from public.\"$T\";")
  printf "   %-20s nguồn=%-6s đích=%-6s %s\n" "$T" "$s" "$d" "$([ "$s" = "$d" ] && echo OK || echo 'LỆCH')"
done

echo "== 4. Tìm ứng viên mới hoặc bị sửa =="
psql "$SRC" -tAF'|' -c 'select id, "updatedAt" from public."Candidate";' | sort -t'|' -k1,1 > "$WORK/s_c.txt"
psql "$DST" -tAF'|' -c 'select id, "updatedAt" from public."Candidate";' | sort -t'|' -k1,1 > "$WORK/d_c.txt"
{ join -t'|' -v1 "$WORK/s_c.txt" "$WORK/d_c.txt" | cut -d'|' -f1
  join -t'|' "$WORK/s_c.txt" "$WORK/d_c.txt" | awk -F'|' '$2!=$3 {print $1}'
} | sort -u > "$WORK/changed.txt"
# Ứng viên đã bị xoá ở nguồn thì cũng phải xoá ở đích.
join -t'|' -v2 "$WORK/s_c.txt" "$WORK/d_c.txt" | cut -d'|' -f1 > "$WORK/removed.txt"
N=$(wc -l < "$WORK/changed.txt" | tr -d ' ')
R=$(wc -l < "$WORK/removed.txt" | tr -d ' ')
echo "   $N ứng viên cần đồng bộ, $R ứng viên cần xoá"

if [ "$R" -gt 0 ]; then
  RIDS=$(awk '{printf "%s'\''%s'\''", (NR>1?",":""), $0}' "$WORK/removed.txt")
  psql "$DST" -v ON_ERROR_STOP=1 -q -c "delete from public.\"Candidate\" where id in ($RIDS);"
fi

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

echo "== 5. Đổi URL ảnh sang Cloudinary =="
python3 - "$WORK/ledger.jsonl" "$WORK/map.csv" <<'PY'
import json, sys, csv
rows = [(d['old_url'], d['secure_url'])
        for d in (json.loads(l) for l in open(sys.argv[1]) if l.strip())]
csv.writer(open(sys.argv[2], 'w', newline='')).writerows(rows)
print(f"   bảng ánh xạ: {len(rows)} cặp")
PY
psql "$DST" -v ON_ERROR_STOP=1 -q <<SQL
drop table if exists _img_map;
create table _img_map (old_url text primary key, new_url text not null);
\copy _img_map from '$WORK/map.csv' with (format csv)
SQL
psql "$DST" -v ON_ERROR_STOP=1 -f "$HERE/scripts/rewrite-image-urls.sql"
psql "$DST" -q -c "drop table if exists _img_map;"

echo "== 6. Kiểm chứng =="
fail=0
for T in Candidate CandidateFormSnapshot FamilyMember "${REF_TABLES[@]}"; do
  s=$(psql "$SRC" -tAc "select count(*) from public.\"$T\";")
  d=$(psql "$DST" -tAc "select count(*) from public.\"$T\";")
  [ "$s" = "$d" ] || fail=1
  printf "   %-24s nguồn=%-6s đích=%-6s %s\n" "$T" "$s" "$d" "$([ "$s" = "$d" ] && echo OK || echo 'LỆCH')"
done
[ "$fail" -eq 0 ] && echo "Xong, tất cả khớp." || { echo "Xong nhưng CÒN LỆCH."; exit 1; }
