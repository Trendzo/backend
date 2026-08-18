/**
 * One-off production migration: drop the gender prefix from category slugs.
 *
 *   npx tsx src/db/seed/indore-market/rename-category-slugs.ts            # dry run
 *   npx tsx src/db/seed/indore-market/rename-category-slugs.ts --confirm  # writes
 *
 * `her-dresses-midi` → `dresses-midi`, and the same for coords, jewelry, ethnic and
 * formal. Gender already lives in `categories.gender`; the slug was duplicating it and
 * forcing callers to guess a rail — the same mistake occasion collections made.
 *
 * Renames rows IN PLACE so ids survive and every listing keeps its category. It does not
 * run the full taxonomy seeder on purpose: that also remaps listings BY NAME, which on a
 * live database could move a retailer's product that happens to share a demo name.
 *
 * Nothing breaks for clients still sending old slugs — `canonicalCategorySlug` normalises
 * inbound slugs in category-tree.ts, and in the GST helpers for historical order
 * snapshots. The listing's own stored `hsn` column is never touched.
 */

import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import * as schema from '@/db/schema/index.js';
import { categories } from '@/db/schema/index.js';
import { env } from '@/config/env.js';
import { LEGACY_CATEGORY_SLUGS } from '@/shared/catalog/taxonomy.js';

const CONFIRM = process.argv.includes('--confirm');

function directUrl(raw: string): string {
  const u = new URL(raw);
  u.hostname = u.hostname.replace('-pooler', '');
  return u.toString();
}

/** Listings per category slug — the before/after invariant that matters. */
async function countsBySlug(db: ReturnType<typeof drizzle>): Promise<Map<string, number>> {
  const res = await db.execute(sql`
    SELECT c.slug, count(pl.id)::int AS n
    FROM categories c
    LEFT JOIN product_listings pl ON pl.category_id = c.id
    GROUP BY c.slug
  `);
  return new Map((res.rows as { slug: string; n: number }[]).map((r) => [r.slug, Number(r.n)]));
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: directUrl(env.DATABASE_URL), max: 1 });
  const db = drizzle(pool, { schema });
  console.log(`\nTarget: ${new URL(directUrl(env.DATABASE_URL)).hostname}`);
  console.log(CONFIRM ? 'Mode: WRITE\n' : 'Mode: DRY RUN — nothing will be written\n');

  const before = await countsBySlug(db);
  const pairs = Object.entries(LEGACY_CATEGORY_SLUGS);
  const todo = pairs.filter(([oldSlug]) => before.has(oldSlug));
  const blocked = todo.filter(([, newSlug]) => before.has(newSlug));

  console.log(`Rename pairs defined      ${pairs.length}`);
  console.log(`Present in this database  ${todo.length}`);
  console.log(`Blocked (target exists)   ${blocked.length}`);
  const movingListings = todo.reduce((n, [oldSlug]) => n + (before.get(oldSlug) ?? 0), 0);
  console.log(`Listings on renamed rows  ${movingListings}`);
  for (const [o, n] of todo.slice(0, 6)) console.log(`  ${o} → ${n}  (${before.get(o)} listings)`);
  if (todo.length > 6) console.log(`  … and ${todo.length - 6} more`);

  if (blocked.length) {
    console.error('\nA target slug already exists — refusing rather than colliding with categories_slug_idx:');
    for (const [o, n] of blocked) console.error(`  ${o} → ${n}`);
    await pool.end();
    process.exit(1);
  }

  if (!CONFIRM) {
    console.log('\nDry run complete. Re-run with --confirm to write.');
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    for (const [oldSlug, newSlug] of todo) {
      await tx.update(categories).set({ slug: newSlug }).where(eq(categories.slug, oldSlug));
    }
  });

  // Every listing must have landed on the renamed row, not been stranded on a deleted
  // one — so the per-slug totals must match exactly once old names map to new.
  const after = await countsBySlug(db);
  const problems: string[] = [];
  for (const [oldSlug, newSlug] of todo) {
    if (after.has(oldSlug)) problems.push(`${oldSlug} still exists`);
    if ((after.get(newSlug) ?? -1) !== (before.get(oldSlug) ?? -2)) {
      problems.push(`${newSlug}: ${after.get(newSlug)} listings, expected ${before.get(oldSlug)}`);
    }
  }
  const beforeTotal = [...before.values()].reduce((a, b) => a + b, 0);
  const afterTotal = [...after.values()].reduce((a, b) => a + b, 0);
  if (beforeTotal !== afterTotal) problems.push(`total listings ${beforeTotal} → ${afterTotal}`);

  if (problems.length) {
    console.error('\nVerification FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
  } else {
    console.log(`\nRenamed ${todo.length} categories. All ${afterTotal} listings intact.`);
  }
  await pool.end();
}

void main().catch((err) => {
  console.error('\nMigration failed:', err);
  process.exit(1);
});
