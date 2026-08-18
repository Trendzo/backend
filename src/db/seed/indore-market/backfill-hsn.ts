/**
 * One-off production migration: repair HSN codes written by the old `parentOf` bug.
 *
 *   npx tsx src/db/seed/indore-market/backfill-hsn.ts            # dry run
 *   npx tsx src/db/seed/indore-market/backfill-hsn.ts --confirm  # writes
 *
 * `parentOf` stripped one `-segment`, so every multi-word leaf missed HSN_BY_PARENT and
 * fell through to the knitwear default 6109 — `coords-two-piece` should have been 6204,
 * `active-track-pants` 6112, `ethnic-kurta-sets` 6205.
 *
 * ONLY rows still holding that generic 6109 fallback are touched, and only where the
 * correct default differs. A retailer who deliberately typed a code keeps it. The GST
 * RATE does not move either way — 6109, 6112, 6203, 6204, 6205 and 6208 are all chapters
 * 61/62, which classify as apparel and take the same price slab — so this corrects what
 * the invoice reports, not what anyone was charged.
 */

import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { inArray, sql } from 'drizzle-orm';
import * as schema from '@/db/schema/index.js';
import { productListings } from '@/db/schema/index.js';
import { env } from '@/config/env.js';
import { categoryDefaultHsn } from '@/shared/pos/gst-rates.js';

const CONFIRM = process.argv.includes('--confirm');
/** The value the buggy resolver produced when it missed. */
const BUGGY_FALLBACK = '6109';

function directUrl(raw: string): string {
  const u = new URL(raw);
  u.hostname = u.hostname.replace('-pooler', '');
  return u.toString();
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: directUrl(env.DATABASE_URL), max: 1 });
  const db = drizzle(pool, { schema });
  console.log(`\nTarget: ${new URL(directUrl(env.DATABASE_URL)).hostname}`);
  console.log(CONFIRM ? 'Mode: WRITE\n' : 'Mode: DRY RUN — nothing will be written\n');

  const res = await db.execute(sql`
    SELECT pl.id, pl.hsn, c.slug
    FROM product_listings pl
    JOIN categories c ON c.id = pl.category_id
    WHERE pl.hsn = ${BUGGY_FALLBACK}
  `);
  const rows = res.rows as { id: string; hsn: string; slug: string }[];

  // Group by the correction so this is a handful of statements, not thousands.
  const byTarget = new Map<string, { ids: string[]; slugs: Set<string> }>();
  for (const r of rows) {
    const correct = categoryDefaultHsn(r.slug);
    if (!correct || correct === r.hsn) continue;
    const entry = byTarget.get(correct) ?? { ids: [], slugs: new Set<string>() };
    entry.ids.push(r.id);
    entry.slugs.add(r.slug);
    byTarget.set(correct, entry);
  }

  const total = [...byTarget.values()].reduce((n, e) => n + e.ids.length, 0);
  console.log(`Listings holding ${BUGGY_FALLBACK}   ${rows.length}`);
  console.log(`Of those, actually wrong    ${total}\n`);
  for (const [correct, e] of byTarget) {
    console.log(`  ${BUGGY_FALLBACK} → ${correct}   ${String(e.ids.length).padStart(4)} listings   (${[...e.slugs].sort().join(', ')})`);
  }

  if (!total) {
    console.log('\nNothing to correct.');
    await pool.end();
    return;
  }
  if (!CONFIRM) {
    console.log('\nDry run complete. Re-run with --confirm to write.');
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    for (const [correct, e] of byTarget) {
      await tx.update(productListings).set({ hsn: correct }).where(inArray(productListings.id, e.ids));
    }
  });

  const after = await db.execute(sql`
    SELECT count(*)::int AS n
    FROM product_listings pl JOIN categories c ON c.id = pl.category_id
    WHERE pl.hsn = ${BUGGY_FALLBACK}
      AND c.slug IN (${sql.join([...new Set(rows.map((r) => r.slug))].map((s) => sql`${s}`), sql`, `)})
  `);
  console.log(`\nCorrected ${total} listings. Still on ${BUGGY_FALLBACK} in those categories: ${(after.rows[0] as { n: number }).n} (expected: only the ones where 6109 is right).`);
  await pool.end();
}

void main().catch((err) => {
  console.error('\nBackfill failed:', err);
  process.exit(1);
});
