/**
 * One-off production migration: make occasion a tag rather than a gendered row.
 *
 *   npx tsx src/db/seed/indore-market/decouple-occasions.ts            # dry run
 *   npx tsx src/db/seed/indore-market/decouple-occasions.ts --confirm  # writes
 *
 * Three changes, all reversible and all idempotent:
 *
 *  1. Occasion collection slugs lose their rail prefix — `her-occasion-brunch` becomes
 *     `brunch`. `collections.gender` already exists as its own column, so the prefix was
 *     duplicating information while forcing callers to guess a rail. Safe: the her tags
 *     (beach/brunch/date/party/wedding) and him tags (formal/gym/office/streetwear/
 *     travel) are disjoint, so no two rows collapse onto one slug.
 *
 *  2. The `page.occasion` CMS tile keyed `street` is corrected to `streetwear`, the tag
 *     117 listings actually carry. `casual` and `weekend` are disabled rather than
 *     deleted: nothing carries those tags, and a tile that resolves to nothing is how
 *     this bug hid in the first place.
 *
 *  3. The 400 Indore listings get their occasion tags backfilled from their leaf's
 *     vocabulary. They were seeded with `occasion: []` because occasion collections
 *     resolved unbounded; now that the endpoint takes a limit, tagging them is safe and
 *     they can appear in the occasion rails alongside the older catalog.
 */

import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, inArray, sql } from 'drizzle-orm';
import * as schema from '@/db/schema/index.js';
import { collections, productListings } from '@/db/schema/index.js';
import { env } from '@/config/env.js';
import { LEAF_SPECS } from './leaf-catalog.js';
import { listingId } from './compose.js';
import { buildSlots } from './distribute.js';

const CONFIRM = process.argv.includes('--confirm');

/** Old rail-prefixed slug → bare tag. */
const SLUG_RENAMES: Record<string, string> = {
  'her-occasion-brunch': 'brunch',
  'her-occasion-date': 'date',
  'her-occasion-beach': 'beach',
  'her-occasion-wedding': 'wedding',
  'her-occasion-party': 'party',
  'him-occasion-office': 'office',
  'him-occasion-streetwear': 'streetwear',
  'him-occasion-gym': 'gym',
  'him-occasion-formal': 'formal',
  'him-occasion-travel': 'travel',
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

  // --- what the occasion backfill would set --------------------------------
  const slots = buildSlots();
  const tagsByListing = new Map<string, string[]>();
  for (const slot of slots) {
    const spec = LEAF_SPECS[slot.leafIndex]!;
    tagsByListing.set(listingId(slot.leafIndex, slot.k), spec.occasion);
  }

  const present = await db
    .select({ id: productListings.id })
    .from(productListings)
    .where(inArray(productListings.id, [...tagsByListing.keys()]));
  const presentIds = new Set(present.map((r) => r.id));

  const renamable = await db
    .select({ slug: collections.slug })
    .from(collections)
    .where(inArray(collections.slug, Object.keys(SLUG_RENAMES)));

  console.log('Plan:');
  console.log(`  collection slugs to rename   ${renamable.length}/${Object.keys(SLUG_RENAMES).length}`);
  console.log(`  listings to backfill tags    ${presentIds.size}`);
  console.log(`  cms tile street → streetwear`);
  console.log(`  cms tiles disabled           casual, weekend`);

  if (!CONFIRM) {
    console.log('\nDry run complete. Re-run with --confirm to write.');
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    for (const [oldSlug, newSlug] of Object.entries(SLUG_RENAMES)) {
      await tx.update(collections).set({ slug: newSlug }).where(eq(collections.slug, oldSlug));
    }

    await tx.execute(
      sql`UPDATE cms_items SET key = 'streetwear' WHERE key = 'street'
          AND section_id IN (SELECT id FROM cms_sections WHERE key = 'page.occasion')`,
    );
    await tx.execute(
      sql`UPDATE cms_items SET is_enabled = false WHERE key IN ('casual','weekend')
          AND section_id IN (SELECT id FROM cms_sections WHERE key = 'page.occasion')`,
    );

    // Group listings by identical tag set so this is a handful of statements, not 400.
    const byTags = new Map<string, string[]>();
    for (const [id, tags] of tagsByListing) {
      if (!presentIds.has(id)) continue;
      const key = JSON.stringify(tags);
      (byTags.get(key) ?? byTags.set(key, []).get(key)!).push(id);
    }
    for (const [tagsJson, ids] of byTags) {
      await tx
        .update(productListings)
        .set({ occasion: JSON.parse(tagsJson) as string[] })
        .where(inArray(productListings.id, ids));
    }
    console.log(`  backfilled ${byTags.size} distinct tag sets across ${presentIds.size} listings`);
  });

  const after = await db
    .select({ slug: collections.slug, tag: collections.occasionTag, gender: collections.gender })
    .from(collections)
    .where(eq(collections.kind, 'occasion'));
  console.log('\nOccasion collections now:');
  for (const r of after) console.log(`  ${r.slug.padEnd(12)} tag=${r.tag} gender=${r.gender}`);

  await pool.end();
}

void main().catch((err) => {
  console.error('\nMigration failed:', err);
  process.exit(1);
});
