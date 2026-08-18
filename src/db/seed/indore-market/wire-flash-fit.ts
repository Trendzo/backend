/**
 * One-off production migration: point Flash Fit at a real drop.
 *
 *   npx tsx src/db/seed/indore-market/wire-flash-fit.ts            # dry run
 *   npx tsx src/db/seed/indore-market/wire-flash-fit.ts --confirm  # writes
 *
 * Flash Fit had no backend behind it at all. The countdown started at a hardcoded
 * 5:32:08, counted down per mount and wrapped to 23h on reaching zero, so it never
 * expired and no two shoppers saw the same number. The "full look" was assembled on the
 * client from the three cheapest distinct-category items. The three home tiles were CMS
 * art with a label and no product. Meanwhile the backend already had timed drops with
 * startsAt/endsAt and curated collections with explicit membership.
 *
 * This sets `home.flash_fit.config.collectionSlug` to a drop and removes the three
 * decorative items, which the app no longer reads.
 */

import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '@/db/schema/index.js';
import { env } from '@/config/env.js';

const CONFIRM = process.argv.includes('--confirm');
/** Needs >= 3 members: the fit is the first three, the rest fill the deals grid. */
const FEATURED_DROP = 'drop-midnight-luxe';

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

  const dropRes = await db.execute(sql`
    SELECT c.slug, c.name, c.kind, c.starts_at, c.ends_at,
           (SELECT count(*)::int FROM collection_listings cl WHERE cl.collection_id = c.id) AS members
    FROM collections c WHERE c.slug = ${FEATURED_DROP}
  `);
  const drop = dropRes.rows[0] as
    | { slug: string; name: string; kind: string; starts_at: string | null; ends_at: string | null; members: number }
    | undefined;

  if (!drop) {
    console.error(`Drop "${FEATURED_DROP}" does not exist.`);
    await pool.end();
    process.exit(1);
  }
  if (drop.members < 3) {
    console.error(`"${FEATURED_DROP}" has ${drop.members} members; the fit needs at least 3.`);
    await pool.end();
    process.exit(1);
  }

  const itemsRes = await db.execute(sql`
    SELECT count(*)::int AS n FROM cms_items i JOIN cms_sections s ON s.id = i.section_id
    WHERE s.key = 'home.flash_fit'
  `);
  const staleItems = Number((itemsRes.rows[0] as { n: number }).n);

  console.log(`Featured drop      ${drop.name} (${drop.slug}, ${drop.kind})`);
  console.log(`  members          ${drop.members}  → 3 in the fit, ${drop.members - 3} in the deals grid`);
  console.log(`  ends at          ${drop.ends_at ?? 'not set — the countdown will stay hidden'}`);
  console.log(`Decorative items to remove  ${staleItems}`);

  if (!CONFIRM) {
    console.log('\nDry run complete. Re-run with --confirm to write.');
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE cms_sections
      SET config = coalesce(config, '{}'::jsonb) || jsonb_build_object('collectionSlug', ${FEATURED_DROP}::text)
      WHERE key = 'home.flash_fit'
    `);
    await tx.execute(sql`
      DELETE FROM cms_items
      WHERE section_id IN (SELECT id FROM cms_sections WHERE key = 'home.flash_fit')
    `);
  });

  console.log(`\nFlash Fit now features "${drop.name}".`);
  if (!drop.ends_at) {
    console.log('No end date on that drop, so the countdown is hidden. Set one in admin → Collections to show it.');
  }
  await pool.end();
}

void main().catch((err) => {
  console.error('\nMigration failed:', err);
  process.exit(1);
});
