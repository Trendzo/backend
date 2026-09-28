/* eslint-disable no-console -- CLI tool: console output is the intended UX */
/**
 * One-off backfill: convert plain-text `product_listings.description_long` values to HTML.
 * Logic + rationale live in src/db/backfill-long-description-html.ts (tested there).
 *
 * Run from backend/ with DATABASE_URL pointing at the target DB:
 *   npx tsx scripts/backfill-long-description-html.ts            # dry run (default)
 *   npx tsx scripts/backfill-long-description-html.ts --apply    # write
 */
import { db, pool } from '@/db/client.js';
import { backfillLongDescriptionHtml } from '@/db/backfill-long-description-html.js';

const apply = process.argv.includes('--apply');

async function main(): Promise<void> {
  console.log(apply ? 'APPLY mode — rows will be updated.' : 'Dry run (pass --apply to write).');
  const r = await backfillLongDescriptionHtml(db, { apply });
  for (const s of r.samples) {
    console.log(`  ${s.id}: ${JSON.stringify(s.before.slice(0, 80))} → ${JSON.stringify(s.after?.slice(0, 120))}`);
  }
  const skipped = r.skippedConcurrent ? ` (${r.skippedConcurrent} skipped: edited mid-run)` : '';
  console.log(
    `Scanned ${r.scanned} listing(s) with a long description; ${r.converted} plain-text ` +
      (apply ? `converted${skipped}.` : 'would be converted.'),
  );
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
