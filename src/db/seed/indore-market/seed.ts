/**
 * Seeds 20 live Indore retailers and 400 coherent products.
 *
 *   npx tsx src/db/seed/indore-market/seed.ts             # dry run, writes nothing
 *   npx tsx src/db/seed/indore-market/seed.ts --confirm   # writes
 *
 * NOT wired into run.ts. This must never be part of `npm run db:seed`.
 *
 * Shape of the run:
 *  1. compose all ~6,200 rows in memory and assert every invariant — offline, no DB;
 *  2. preflight against the DB (categories, brands, id/email/phone collisions);
 *  3. hash the 20 bcrypt passwords BEFORE opening the transaction (bcrypt is seconds
 *     of CPU and must not be held inside it);
 *  4. one transaction: bulk inserts only, then re-read the 400 through the real
 *     publishability + visibility predicates, and ROLLBACK if any fails;
 *  5. write manifest.json so teardown deletes by exact id list rather than a LIKE.
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '@/db/schema/index.js';
import {
  bankAccounts,
  brands,
  categories,
  productListings,
  retailerAccounts,
  retailerStores,
  retailerTermsAcceptances,
  variantGroups,
  variants,
} from '@/db/schema/index.js';
import { env } from '@/config/env.js';
import { currentLegalDoc } from '@/shared/terms.js';
import { compose, loadImagePool, accountId, acceptanceId, bankId, storeId } from './compose.js';
import { checkInvariants, summarise } from './invariants.js';
import { NEW_BRANDS } from './leaf-catalog.js';
import { OPENING_HOURS, STORES } from './stores.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(HERE, 'manifest.json');

const CONFIRM = process.argv.includes('--confirm');
const CHUNK = 200;
const PASSWORD = process.env.SEED_RETAILER_PASSWORD ?? 'Trendzo@2026';

const chunked = <T>(rows: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
};

/**
 * Neon's `-pooler` host is PgBouncer in transaction mode. A long multi-statement
 * transaction belongs on the direct endpoint.
 */
function directUrl(raw: string): string {
  const u = new URL(raw);
  u.hostname = u.hostname.replace('-pooler', '');
  return u.toString();
}

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: directUrl(env.DATABASE_URL),
    max: 1,
    connectionTimeoutMillis: 20_000,
  });
  const db = drizzle(pool, { schema });
  const host = new URL(directUrl(env.DATABASE_URL)).hostname;

  console.log(`\nTarget database: ${host}`);
  console.log(CONFIRM ? 'Mode: WRITE (--confirm given)\n' : 'Mode: DRY RUN — nothing will be written\n');

  // --- 1. compose + assert, entirely offline -------------------------------
  const pool_ = loadImagePool();
  const composed = compose(pool_, new Date());
  const problems = checkInvariants(composed, pool_);
  if (problems.length) {
    console.error(`Invariant violations (${problems.length}):`);
    for (const p of problems.slice(0, 40)) console.error(`  - ${p}`);
    if (problems.length > 40) console.error(`  … and ${problems.length - 40} more`);
    await pool.end();
    process.exit(1);
  }
  console.log('Invariants: all pass.');
  const counts = summarise(composed);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(18)} ${v}`);

  // --- 2. preflight against the live DB ------------------------------------
  const leafSlugs = [...new Set(composed.listings.map((l) => l.categorySlug))];
  const catRows = await db
    .select({ id: categories.id, slug: categories.slug })
    .from(categories)
    .where(inArray(categories.slug, leafSlugs));
  const catBySlug = new Map(catRows.map((c) => [c.slug, c.id]));
  const missingCats = leafSlugs.filter((s) => !catBySlug.has(s));
  if (missingCats.length) {
    console.error(`\n${missingCats.length} leaf categories are not in the database:`);
    for (const s of missingCats.slice(0, 10)) console.error(`  - ${s}`);
    console.error('Run `npm run db:seed` first so the taxonomy exists.');
    await pool.end();
    process.exit(1);
  }

  const wantedBrands = [...new Set(composed.listings.map((l) => l.brandSlug))];
  const brandRows = await db
    .select({ id: brands.id, slug: brands.slug })
    .from(brands)
    .where(inArray(brands.slug, wantedBrands));
  const brandBySlug = new Map(brandRows.map((b) => [b.slug, b.id]));
  const missingBrands = wantedBrands.filter((s) => !brandBySlug.has(s));
  // A brand the vocabulary references, that is neither in the DB nor in NEW_BRANDS,
  // would otherwise only blow up inside the transaction. Catch it in the dry run.
  const newBrandSlugs = new Set<string>(NEW_BRANDS.map((b) => b.slug));
  const uncreatable = missingBrands.filter((s) => !newBrandSlugs.has(s));

  const storeIds = STORES.map((s) => storeId(s.n));
  const existingStores = await db
    .select({ id: retailerStores.id })
    .from(retailerStores)
    .where(inArray(retailerStores.id, storeIds));
  const emails = STORES.map((s) => s.owner.email);
  const phones = STORES.map((s) => s.owner.phone);
  const clashEmail = await db
    .select({ email: retailerAccounts.email })
    .from(retailerAccounts)
    .where(inArray(retailerAccounts.email, emails));
  const clashPhone = await db
    .select({ phone: retailerAccounts.phone })
    .from(retailerAccounts)
    .where(inArray(retailerAccounts.phone, phones));

  console.log(`\nPreflight:`);
  console.log(`  leaf categories resolved   ${catBySlug.size}/${leafSlugs.length}`);
  console.log(`  brands present             ${brandBySlug.size}/${wantedBrands.length}` + (missingBrands.length ? ` (will create ${missingBrands.length})` : ''));
  console.log(`  seed stores already there  ${existingStores.length}`);
  console.log(`  email collisions           ${clashEmail.length}`);
  console.log(`  phone collisions           ${clashPhone.length}`);

  if (uncreatable.length) {
    console.error(`\nBrands referenced by leaf-catalog.ts but neither seeded nor in NEW_BRANDS:`);
    for (const s of uncreatable) console.error(`  - ${s}`);
    await pool.end();
    process.exit(1);
  }
  if (existingStores.length) {
    console.error('\nThese stores already exist. Run teardown.ts first, or leave them be.');
    await pool.end();
    process.exit(1);
  }
  if (clashEmail.length || clashPhone.length) {
    console.error('\nOwner email/phone collides with a real retailer account. Aborting.');
    await pool.end();
    process.exit(1);
  }

  if (!CONFIRM) {
    console.log('\nDry run complete. Re-run with --confirm to write.');
    await pool.end();
    return;
  }

  // --- 3. bcrypt BEFORE the transaction ------------------------------------
  console.log('\nHashing passwords…');
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  // --- 4. one transaction --------------------------------------------------
  console.log('Writing…');
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '120s'`);
    await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout = '300s'`);

    // Brands the leaf vocabulary needs but the existing seed never created.
    for (const b of NEW_BRANDS) {
      if (brandBySlug.has(b.slug)) continue;
      const id = `brd_s2_${b.slug}`;
      await tx
        .insert(brands)
        .values({ id, slug: b.slug, name: b.name, tintColor: b.tintColor, domain: b.domain, isActive: true })
        .onConflictDoNothing();
      const [row] = await tx.select({ id: brands.id }).from(brands).where(eq(brands.slug, b.slug));
      if (row) brandBySlug.set(b.slug, row.id);
    }
    const stillMissing = wantedBrands.filter((s) => !brandBySlug.has(s));
    if (stillMissing.length) throw new Error(`Unresolved brands: ${stillMissing.join(', ')}`);

    // Legal versions read INSIDE the transaction: if an admin publishes a new one
    // mid-run, acceptance rows written against a stale version would silently
    // re-prompt all 20 retailers on first login.
    const termsVersion = (await currentLegalDoc(tx as never, 'terms')).version;
    const privacyVersion = (await currentLegalDoc(tx as never, 'privacy')).version;

    // -- stores, owners, banks, acceptances --
    await tx.insert(retailerStores).values(
      STORES.map((s) => ({
        id: storeId(s.n),
        legalEntityId: s.legalEntityId,
        legalName: s.legalName,
        gstin: s.gstin,
        pan: s.pan,
        address: s.address,
        stateCode: 'MP',
        lat: s.lat,
        lng: s.lng,
        openingHours: OPENING_HOURS,
        contactPhone: s.contactPhone,
        managerName: s.owner.name,
        status: 'active' as const,
        platformFeeBp: s.platformFeeBp,
        payoutCadenceDays: s.payoutCadenceDays,
        posBillingEnabled: s.posBillingEnabled,
      })),
    );

    await tx.insert(retailerAccounts).values(
      STORES.map((s) => ({
        id: accountId(s.n),
        storeId: storeId(s.n),
        email: s.owner.email,
        passwordHash,
        legalName: s.owner.name,
        phone: s.owner.phone,
        gstin: s.gstin,
        subRole: 'owner' as const,
        status: 'active' as const,
      })),
    );

    await tx.insert(bankAccounts).values(
      STORES.map((s) => ({
        id: bankId(s.n),
        storeId: storeId(s.n),
        accountNumber: s.bank.accountNumber,
        ifsc: s.bank.ifsc,
        legalName: s.legalName,
        isDefault: true,
      })),
    );

    await tx.insert(retailerTermsAcceptances).values(
      STORES.flatMap((s) => [
        {
          id: acceptanceId(s.n, 'terms'),
          storeId: storeId(s.n),
          acceptedByAccountId: accountId(s.n),
          docKind: 'terms',
          termsVersion,
          decision: 'accepted',
          userAgent: 'indore-market-seed',
        },
        {
          id: acceptanceId(s.n, 'privacy'),
          storeId: storeId(s.n),
          acceptedByAccountId: accountId(s.n),
          docKind: 'privacy',
          termsVersion: privacyVersion,
          decision: 'accepted',
          userAgent: 'indore-market-seed',
        },
      ]),
    );

    // -- listings, groups, variants (chunked: ~65k bind-param ceiling) --
    for (const batch of chunked(composed.listings)) {
      await tx.insert(productListings).values(
        batch.map((l) => ({
          id: l.id,
          storeId: l.storeId,
          brandId: brandBySlug.get(l.brandSlug)!,
          categoryId: catBySlug.get(l.categorySlug)!,
          name: l.name,
          description: l.description,
          descriptionLong: l.descriptionLong,
          hsn: l.hsn,
          gender: l.gender,
          listingPolicy: 'return' as const,
          galleryUrls: l.galleryUrls,
          // Deliberately empty: occasion tags auto-join the live, UNBOUNDED occasion
          // collections (catalog.controller.ts:708) — 400 listings would be returned
          // in a single unpaginated consumer response.
          occasion: [],
          ageGroups: [],
          status: 'active' as const,
          variantMode: 'color_size' as const,
          createdAt: l.createdAt,
          updatedAt: l.createdAt,
        })),
      );
    }

    const allGroups = composed.listings.flatMap((l) =>
      l.groups.map((g) => ({
        id: g.id,
        listingId: g.listingId,
        storeId: l.storeId,
        name: g.name,
        colorHex: g.colorHex,
        sortOrder: g.sortOrder,
        isDefault: g.isDefault,
        isActive: true,
      })),
    );
    for (const batch of chunked(allGroups)) await tx.insert(variantGroups).values(batch);

    const allVariants = composed.listings.flatMap((l) =>
      l.variants.map((v) => ({
        id: v.id,
        listingId: v.listingId,
        storeId: l.storeId,
        groupId: v.groupId,
        sku: v.sku,
        attributes: { size: v.size, color: v.colorName },
        attributesLabel: v.attributesLabel,
        // Empty on purpose. fix-images.ts:95-110 documents the regression: a variant
        // image WINS over the gallery, so a wrong one permanently hides the good shot.
        imageUrls: [],
        isActive: true,
        stock: v.stock,
        reserved: 0,
        pricePaise: v.pricePaise,
        ...(v.compareAtPrice != null ? { compareAtPrice: v.compareAtPrice } : {}),
      })),
    );
    for (const batch of chunked(allVariants)) await tx.insert(variants).values(batch);

    // --- 5. verify through the REAL predicates, then commit ----------------
    // Raw SQL with an explicit `pl` alias. Interpolating drizzle Column objects into a
    // template that also declares its own aliases leaves bare column references the
    // planner can resolve against more than one relation ("column reference id is
    // ambiguous", SQLSTATE 42702).
    const verify = await tx.execute(sql`
      SELECT
        count(*)::int AS listings,
        count(*) FILTER (
          WHERE pl.status = 'active'
            AND coalesce(btrim(pl.name), '') <> ''
            AND coalesce(btrim(pl.description), '') <> ''
            AND coalesce(btrim(pl.description_long), '') <> ''
            AND jsonb_array_length(pl.gallery_urls) >= 1
            AND EXISTS (
              SELECT 1
              FROM variants v
              JOIN variant_groups vg ON vg.id = v.group_id
              WHERE v.listing_id = pl.id
                AND v.is_active AND vg.is_active
                AND v.price_paise > 0 AND v.sku IS NOT NULL
            )
        )::int AS publishable
      FROM product_listings pl
      WHERE pl.store_id IN (${sql.join(storeIds.map((id) => sql`${id}`), sql`, `)})
    `);
    const check = verify.rows[0] as { listings: number; publishable: number } | undefined;

    console.log(`  verified: ${check?.publishable}/${check?.listings} listings publishable + visible`);
    if (check?.listings !== composed.listings.length || check.publishable !== composed.listings.length) {
      throw new Error('Post-write verification failed — rolling back.');
    }

    const [storeCheck] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(retailerStores)
      .where(and(inArray(retailerStores.id, storeIds), eq(retailerStores.status, 'active')));
    if (storeCheck?.n !== STORES.length) throw new Error('Not all stores are active — rolling back.');
  });

  // --- manifest: teardown deletes by exact id, never by LIKE ---------------
  writeFileSync(
    MANIFEST_PATH,
    `${JSON.stringify(
      {
        seededAt: new Date().toISOString(),
        host,
        storeIds,
        accountIds: STORES.map((s) => accountId(s.n)),
        bankIds: STORES.map((s) => bankId(s.n)),
        acceptanceIds: STORES.flatMap((s) => [acceptanceId(s.n, 'terms'), acceptanceId(s.n, 'privacy')]),
        listingIds: composed.listings.map((l) => l.id),
        groupIds: composed.listings.flatMap((l) => l.groups.map((g) => g.id)),
        variantIds: composed.listings.flatMap((l) => l.variants.map((v) => v.id)),
        brandSlugs: NEW_BRANDS.map((b) => b.slug),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.log(`\nDone. Manifest → ${MANIFEST_PATH}`);
  console.log(`Retailer logins: ${STORES[0]!.owner.email} … (20 accounts), password: ${PASSWORD}`);
  await pool.end();
}

void main().catch(async (err) => {
  console.error('\nSeed failed:', err);
  process.exit(1);
});
