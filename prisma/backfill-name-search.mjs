// Backfill cột Candidate.nameSearch cho dữ liệu cũ.
// Chạy 1 lần sau khi apply migration add_moderation_and_name_search:
//   node prisma/backfill-name-search.mjs
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function normalizeSearch(input) {
  if (typeof input !== 'string') return '';
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  const candidates = await prisma.candidate.findMany({
    select: { id: true, vietnameseName: true, chineseName: true },
  });
  console.log(`Backfilling nameSearch for ${candidates.length} candidates...`);

  let updated = 0;
  for (const c of candidates) {
    const nameSearch =
      normalizeSearch([c.vietnameseName, c.chineseName].filter(Boolean).join(' ')) || null;
    await prisma.candidate.update({ where: { id: c.id }, data: { nameSearch } });
    updated += 1;
  }
  console.log(`Done. Updated ${updated} rows.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
