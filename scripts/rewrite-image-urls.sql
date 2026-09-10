-- Đổi URL ảnh trong DB đích từ Supabase Storage sang Cloudinary.
-- Cần bảng _img_map (old_url, new_url) đã nạp sẵn từ sổ theo dõi của script upload.
-- Chạy: psql "$DST" -v ON_ERROR_STOP=1 -f scripts/rewrite-image-urls.sql

\set BASE 'https://nzlcqizlpnrikshajyhe.supabase.co/storage/v1/object/public/imageKesa'

begin;

-- Không có ánh xạ thì dừng ngay, tránh xoá sạch URL bằng NULL.
do $$
begin
  if (select count(*) from _img_map) = 0 then
    raise exception 'Bảng _img_map rỗng, không có gì để đổi.';
  end if;
end $$;

-- 1. Hai cột text đơn.
update public."Candidate" c
set "avatarUrl" = m.new_url
from _img_map m
where c."avatarUrl" = m.old_url;

update public."Candidate" c
set "lineImageUrl" = m.new_url
from _img_map m
where c."lineImageUrl" = m.old_url;

-- 2. Ba cột mảng. Giữ nguyên thứ tự phần tử; phần tử không có ánh xạ thì để nguyên.
update public."Candidate" c
set "tattooImages" = (
  select array_agg(coalesce(m.new_url, e) order by ord)
  from unnest(c."tattooImages") with ordinality t(e, ord)
  left join _img_map m on m.old_url = t.e
)
where c."tattooImages" is not null
  and exists (select 1 from unnest(c."tattooImages") e join _img_map m on m.old_url = e);

update public."Candidate" c
set "scarImages" = (
  select array_agg(coalesce(m.new_url, e) order by ord)
  from unnest(c."scarImages") with ordinality t(e, ord)
  left join _img_map m on m.old_url = t.e
)
where c."scarImages" is not null
  and exists (select 1 from unnest(c."scarImages") e join _img_map m on m.old_url = e);

update public."Candidate" c
set "limbImages" = (
  select array_agg(coalesce(m.new_url, e) order by ord)
  from unnest(c."limbImages") with ordinality t(e, ord)
  left join _img_map m on m.old_url = t.e
)
where c."limbImages" is not null
  and exists (select 1 from unnest(c."limbImages") e join _img_map m on m.old_url = e);

-- 3. Cột jsonb. Với mỗi bản ghi, chỉ thay đúng những URL thực sự xuất hiện trong đó.
do $$
declare
  base text := 'https://nzlcqizlpnrikshajyhe.supabase.co/storage/v1/object/public/imageKesa';
  r record;
  txt text;
  found text;
  mapped text;
  n_rows int := 0;
begin
  for r in
    select id, data::text as raw
    from public."CandidateFormSnapshot"
    where data::text like '%' || base || '%'
  loop
    txt := r.raw;
    for found in
      select distinct mm[1]
      from regexp_matches(r.raw, base || '/[A-Za-z0-9._/-]+', 'g') as mm
    loop
      select new_url into mapped from _img_map where old_url = found;
      -- Không tìm thấy ánh xạ thì để nguyên URL cũ, ảnh vẫn xem được vì bucket là public.
      if mapped is not null then
        txt := replace(txt, found, mapped);
      end if;
    end loop;
    if txt is distinct from r.raw then
      update public."CandidateFormSnapshot" set data = txt::jsonb where id = r.id;
      n_rows := n_rows + 1;
    end if;
  end loop;
  raise notice 'CandidateFormSnapshot: đã đổi % bản ghi', n_rows;
end $$;

commit;

-- Kiểm chứng: còn URL Supabase nào sót lại không.
select 'Candidate.avatarUrl' as cot, count(*) as con_sot
  from public."Candidate" where "avatarUrl" like :'BASE' || '%'
union all select 'Candidate.lineImageUrl', count(*)
  from public."Candidate" where "lineImageUrl" like :'BASE' || '%'
union all select 'Candidate.tattooImages', count(*)
  from public."Candidate" where array_to_string("tattooImages", ',') like '%' || :'BASE' || '%'
union all select 'Candidate.scarImages', count(*)
  from public."Candidate" where array_to_string("scarImages", ',') like '%' || :'BASE' || '%'
union all select 'Candidate.limbImages', count(*)
  from public."Candidate" where array_to_string("limbImages", ',') like '%' || :'BASE' || '%'
union all select 'CandidateFormSnapshot.data', count(*)
  from public."CandidateFormSnapshot" where data::text like '%' || :'BASE' || '%';
