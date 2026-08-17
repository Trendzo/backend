/**
 * Removes exactly what seed.ts created, and nothing else.
 *
 *   npx tsx src/db/seed/indore-market/teardown.ts             # dry run
 *   npx tsx src/db/seed/indore-market/teardown.ts --confirm   # deletes
 *
 * Deletes by the exact id lists in manifest.json — never by `LIKE '%_s2_%'`. In LIKE,
 * `_` is a single-character wildcard, so an unescaped pattern would also match ids that
 * merely resemble the marker. Pattern-matching a production DELETE is not worth it when
 * the precise id list is sitting in a file.
 *
 * REFUSES to run if any of these stores has acquired real history — an order, a POS
 * sale, an invoice, a payout, a return. At that point the store is not disposable, and
 * deleting it would orphan a consumer's order or void a tax document.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { inArray, sql } from 'drizzle-orm';
import * as schema from '@/db/schema/index.js';
import {
  bankAccounts,
  productListings,
  retailerAccounts,
  retailerStores,
  retailerTermsAcceptances,
  variantGroups,
  variants,
} from '@/db/schema/index.js';
import { env } from '@/config/env.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(HERE, 'manifest.json');
const CONFIRM = process.argv.includes('--confirm');

type Manifest = {
  host: string;
  storeIds: string[];
  accountIds: string[];
  bankIds: string[];
  acceptanceIds: string[];
  listingIds: string[];
  groupIds: string[];
  variantIds: string[];
};

function directUrl(raw: string): string {
  const u = new URL(raw);
  u.hostname = u.hostname.replace('-pooler', '');
  return u.toString();
}

/**
 * Tables that hold real business history against a store or its catalog. Every one of
 * these is a RESTRICT foreign key, so the delete would fail anyway — but failing with a
 * clear reason beats a raw constraint violation halfway through.
 */
const HISTORY_BY_STORE = [
  'orders',
  'pos_sales',
  'pos_customers',
  'invoices',
  'credit_notes',
  'payouts',
  'billing_statements',
  'returns',
  'reverse_pickups',
  'customer_issues',
  'ai_catalog_submissions',
  'promotions',
] as const;

const HISTORY_BY_LISTING = ['order_items', 'pos_sale_items', 'moodboard_items', 'reels'] as const;

async function main(): Promise<void> {
  if (!existsSync(MANIFEST_PATH)) {
    console.error(`No manifest.json at ${MANIFEST_PATH}. Nothing to tear down.`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;

  const pool = new Pool({ connectionString: directUrl(env.DATABASE_URL), max: 1 });
  const db = drizzle(pool, { schema });
  const host = new URL(directUrl(env.DATABASE_URL)).hostname;

  console.log(`\nTarget database: ${host}`);
  if (manifest.host && manifest.host !== host) {
    console.error(`Manifest was written against ${manifest.host}. Refusing to delete on a different host.`);
    await pool.end();
    process.exit(1);
  }
  console.log(CONFIRM ? 'Mode: DELETE (--confirm given)\n' : 'Mode: DRY RUN — nothing will be deleted\n');

  // --- refuse if there is real history -------------------------------------
  const blockers: string[] = [];
  for (const table of HISTORY_BY_STORE) {
    const res = await db.execute(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE store_id = ANY(${manifest.storeIds})`,
    );
    const n = Number((res.rows[0] as { n: number } | undefined)?.n ?? 0);
    if (n > 0) blockers.push(`${table}: ${n} row(s)`);
  }
  for (const table of HISTORY_BY_LISTING) {
    const col = table === 'reels' ? 'product_id' : 'listing_id';
    const res = await db.execute(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE ${sql.identifier(col)} = ANY(${manifest.listingIds})`,
    );
    const n = Number((res.rows[0] as { n: number } | undefined)?.n ?? 0);
    if (n > 0) blockers.push(`${table}: ${n} row(s)`);
  }

  if (blockers.length) {
    console.error('These stores have real history. Refusing to delete:');
    for (const b of blockers) console.error(`  - ${b}`);
    console.error('\nSomeone has ordered from, or engaged with, this seeded catalog.');
    await pool.end();
    process.exit(1);
  }
  console.log('History check: clean (no orders, sales, invoices, payouts, returns or reels).');

  const counts = {
    variants: manifest.variantIds.length,
    variantGroups: manifest.groupIds.length,
    listings: manifest.listingIds.length,
    acceptances: manifest.acceptanceIds.length,
    bankAccounts: manifest.bankIds.length,
    accounts: manifest.accountIds.length,
    stores: manifest.storeIds.length,
  };
  console.log('\nWould delete:');
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(16)} ${v}`);

  if (!CONFIRM) {
    console.log('\nDry run complete. Re-run with --confirm to delete.');
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    // Cascade-linked analytics/moderation children first so the counts are visible
    // rather than silently swept by ON DELETE CASCADE.
    await tx.execute(sql`DELETE FROM inventory_reservations WHERE variant_id = ANY(${manifest.variantIds})`);
    await tx.execute(sql`DELETE FROM inventory_adjustments WHERE variant_id = ANY(${manifest.variantIds})`);
    await tx.execute(sql`DELETE FROM listing_views WHERE listing_id = ANY(${manifest.listingIds})`);
    await tx.execute(sql`DELETE FROM cart_events WHERE listing_id = ANY(${manifest.listingIds})`);
    await tx.execute(sql`DELETE FROM collection_listings WHERE listing_id = ANY(${manifest.listingIds})`);
    await tx.execute(sql`DELETE FROM product_reviews WHERE listing_id = ANY(${manifest.listingIds})`);
    await tx.execute(sql`DELETE FROM listing_audit_entries WHERE listing_id = ANY(${manifest.listingIds})`);

    await tx.delete(variants).where(inArray(variants.id, manifest.variantIds));
    await tx.delete(variantGroups).where(inArray(variantGroups.id, manifest.groupIds));
    await tx.delete(productListings).where(inArray(productListings.id, manifest.listingIds));

    await tx.execute(sql`DELETE FROM store_media WHERE store_id = ANY(${manifest.storeIds})`);
    await tx.execute(sql`DELETE FROM store_pickup_slots WHERE store_id = ANY(${manifest.storeIds})`);
    await tx.execute(sql`DELETE FROM store_holiday_closures WHERE store_id = ANY(${manifest.storeIds})`);
    await tx.execute(sql`DELETE FROM retailer_staff_invites WHERE store_id = ANY(${manifest.storeIds})`);

    await tx
      .delete(retailerTermsAcceptances)
      .where(inArray(retailerTermsAcceptances.id, manifest.acceptanceIds));
    await tx.delete(bankAccounts).where(inArray(bankAccounts.id, manifest.bankIds));
    await tx.delete(retailerAccounts).where(inArray(retailerAccounts.id, manifest.accountIds));
    await tx.delete(retailerStores).where(inArray(retailerStores.id, manifest.storeIds));

    const [left] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(retailerStores)
      .where(inArray(retailerStores.id, manifest.storeIds));
    if (left?.n !== 0) throw new Error(`${left?.n} stores survived the delete — rolling back.`);
  });

  console.log('\nDeleted. Brands created by the seed were left in place (harmless, and may now be in use).');
  await pool.end();
}

void main().catch((err) => {
  console.error('\nTeardown failed:', err);
  process.exit(1);
});
