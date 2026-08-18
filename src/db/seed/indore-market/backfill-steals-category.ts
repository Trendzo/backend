/**
 * One-off production migration: give each Steals tile the category it claims to show.
 *
 *   npx tsx src/db/seed/indore-market/backfill-steals-category.ts            # dry run
 *   npx tsx src/db/seed/indore-market/backfill-steals-category.ts --confirm  # writes
 *
 * The tiles carried only `label`, `priceLine` and `qualifier` — the label was a caption
 * with nothing behind it, so "T-shirts under ₹1499" queried the whole catalog
 * cheapest-first and returned face serum. Each tile now gets a real `categorySlug`,
 * matched to the label it already displays.
 *
 * Idempotent: a tile that already has one is left alone.
 */

import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '@/db/schema/index.js';
import { env } from '@/config/env.js';

const CONFIRM = process.argv.includes('--confirm');

/** CMS item key → the taxonomy leaf/parent its label already promises. */
const CATEGORY_BY_ITEM: Record<string, string> = {
  'steal-her-1': 'beauty',
  'steal-her-2': 'jewelry',
  'steal-her-3': 'tops',
  'steal-him-1': 'tops-tshirts',
  'steal-him-2': 'accessories-sunglasses',
  'steal-him-3': 'outerwear-jackets',
};

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
    SELECT i.key, i.content->>'label' AS label, i.content->>'categorySlug' AS current
    FROM cms_items i JOIN cms_sections s ON s.id = i.section_id
    WHERE s.key = 'home.steals'
    ORDER BY i.sort_order
  `);
  const rows = res.rows as { key: string; label: string; current: string | null }[];

  // Every target must be a real category, or we reintroduce the bug we are fixing.
  const wanted = [...new Set(Object.values(CATEGORY_BY_ITEM))];
  const found = await db.execute(
    sql`SELECT slug FROM categories WHERE slug IN (${sql.join(wanted.map((s) => sql`${s}`), sql`, `)})`,
  );
  const real = new Set((found.rows as { slug: string }[]).map((r) => r.slug));
  const bogus = wanted.filter((s) => !real.has(s));

  console.log('Steals tiles:');
  for (const r of rows) {
    const target = CATEGORY_BY_ITEM[r.key];
    const note = !target ? 'no mapping' : r.current ? `already ${r.current}` : `→ ${target}`;
    console.log(`  ${r.key.padEnd(14)} ${String(r.label).padEnd(12)} ${note}`);
  }
  if (bogus.length) {
    console.error(`\nThese target slugs do not exist: ${bogus.join(', ')}`);
    await pool.end();
    process.exit(1);
  }

  const todo = rows.filter((r) => CATEGORY_BY_ITEM[r.key] && !r.current);
  console.log(`\nTo update: ${todo.length}`);
  if (!todo.length || !CONFIRM) {
    console.log(todo.length ? '\nDry run complete. Re-run with --confirm to write.' : '\nNothing to do.');
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    for (const r of todo) {
      await tx.execute(sql`
        UPDATE cms_items
        SET content = content || jsonb_build_object('categorySlug', ${CATEGORY_BY_ITEM[r.key]}::text)
        WHERE key = ${r.key}
          AND section_id IN (SELECT id FROM cms_sections WHERE key = 'home.steals')
      `);
    }
  });

  console.log(`\nUpdated ${todo.length} tiles.`);
  await pool.end();
}

void main().catch((err) => {
  console.error('\nBackfill failed:', err);
  process.exit(1);
});
