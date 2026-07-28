/* eslint-disable no-console -- CLI seed: console output is the intended UX */
/**
 * Image URL repair — pngimg.com hotlinks fail on consumer devices (CDN bot
 * challenge), so every category image, listing gallery, and variant image that
 * points at pngimg (or is empty) is re-pointed at verified Unsplash photos.
 *
 * Idempotent: only pngimg/empty URLs are rewritten; Unsplash URLs are kept.
 * Safe to run after every seed (wired into run.ts).
 *
 * Run standalone: npx tsx src/db/seed/fix-images.ts
 */

import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import type { db as Db } from '@/db/client.js';
import { categories, productListings, variants } from '@/db/schema/index.js';

const u = (id: string, w = 600) =>
  `https://images.unsplash.com/photo-${id}?w=${w}&q=80&auto=format&fit=crop`;

/**
 * Pools are keyed by TAXONOMY PARENT slug (`tops`, `shoes`, `her-dresses`…). Leaves
 * inherit their parent's pool via `poolFor`, so adding a sub-category never needs new
 * art here — `tops-bodysuits` draws from the `tops` pool.
 *
 * Every id verified 200 OK on images.unsplash.com.
 */
const POOLS: Record<string, string[]> = {
  tops: [u('1485518882345-15568b007407'), u('1521572163474-6864f9cf17ab'), u('1503341504253-dff4815485f1'), u('1576566588028-4147f3842f27')],
  'her-dresses': [u('1595777457583-95e059d581b8'), u('1572804013309-59a88b7e92f1'), u('1612336307429-8a898d10e223'), u('1496747611176-843222e1e57c')],
  'her-coords': [u('1583496661160-fb5886a0aaaa'), u('1604176354204-9268737828e4'), u('1572804013309-59a88b7e92f1')],
  bottoms: [u('1541099649105-f69ad21f3246'), u('1604176354204-9268737828e4'), u('1583496661160-fb5886a0aaaa'), u('1473966968600-fa801b869a1a')],
  denim: [u('1624378439575-d8705ad7ae80'), u('1541099649105-f69ad21f3246'), u('1473966968600-fa801b869a1a')],
  lounge: [u('1522335789203-aabd1fc54bc9'), u('1485518882345-15568b007407'), u('1552902865-b72c031ac5ea')],
  active: [u('1556821840-3a63f95609a7'), u('1509942774463-acf339cf87d5'), u('1552902865-b72c031ac5ea')],
  swim: [u('1544022613-e87ca75a784a'), u('1496747611176-843222e1e57c'), u('1509942774463-acf339cf87d5')],
  outerwear: [u('1551028719-00167b16eac5'), u('1559551409-dadc959f76b8'), u('1542406775-ade58c52d2e4'), u('1507003211169-0a1dd7228f2d')],
  shoes: [u('1542291026-7eec264c27ff'), u('1549298916-b41d501d3772'), u('1595950653106-6c9ebd614d3a'), u('1600185365926-3a2ce3cdb9eb'), u('1543163521-1bf539c55dd2'), u('1596703263926-eb0762ee17e4')],
  bags: [u('1584917865442-de89df76afd3'), u('1590874103328-eac38a683ce7'), u('1548036328-c9fa89d128fa'), u('1553062407-98eeb64c6a62')],
  accessories: [u('1553062407-98eeb64c6a62'), u('1588850561407-ed78c282e89b'), u('1586350977771-b3b0abd50c82'), u('1572635196237-14b3f281503f'), u('1524592094714-0f0654e20314'), u('1511499767150-a48a237f0083')],
  'her-jewelry': [u('1523275335684-37898b6baf30'), u('1586350977771-b3b0abd50c82'), u('1588850561407-ed78c282e89b')],
  beauty: [u('1586495777744-4413f21062fa'), u('1522335789203-aabd1fc54bc9')],
  'him-ethnic': [u('1596755094514-f87e34085b2c'), u('1602810318383-e386cc2a3ccf')],
  'him-formal': [u('1602810318383-e386cc2a3ccf'), u('1596755094514-f87e34085b2c'), u('1522312346375-d1a52e2b99b3')],
  // Retired flat slugs, kept so a partially-migrated DB still resolves.
  apparel: [u('1556821840-3a63f95609a7'), u('1509942774463-acf339cf87d5'), u('1521572163474-6864f9cf17ab'), u('1552902865-b72c031ac5ea')],
  footwear: [u('1549298916-b41d501d3772'), u('1595950653106-6c9ebd614d3a'), u('1600185365926-3a2ce3cdb9eb'), u('1542291026-7eec264c27ff')],
};

/** Leaf → parent → apparel fallback. Slugs are `<parent>-<leaf>`, so strip one segment. */
const poolFor = (slug: string | undefined): string[] => {
  if (!slug) return POOLS.apparel!;
  const direct = POOLS[slug];
  if (direct) return direct;
  const cut = slug.lastIndexOf('-');
  return (cut === -1 ? undefined : POOLS[slug.slice(0, cut)]) ?? POOLS.apparel!;
};

const isBroken = (url: string) => url.includes('pngimg.com');
const keepGood = (urls: string[]) => urls.filter((x) => !isBroken(x));

export async function fixImages(database: typeof Db): Promise<void> {
  // 1. Categories — replace pngimg/empty imageUrl with the pool lead image.
  const cats = await database.query.categories.findMany();
  const slugById = new Map(cats.map((c) => [c.id, c.slug]));
  let catFixed = 0;
  for (const c of cats) {
    if (c.imageUrl && !isBroken(c.imageUrl)) continue;
    const pool = poolFor(c.slug);
    // Spread leaves across their parent's pool so sibling tiles aren't all the same shot.
    const lead = pool[c.sortOrder % pool.length] ?? pool[0]!;
    await database.update(categories).set({ imageUrl: lead }).where(eq(categories.id, c.id));
    catFixed++;
  }
  console.log(`  → fixed ${catFixed} category images`);

  // 2. Listings — rebuild galleries: keep existing Unsplash shots, fill from the pool.
  const listings = await database.query.productListings.findMany({
    columns: { id: true, categoryId: true, galleryUrls: true },
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });
  let galleryFixed = 0;
  for (const [i, l] of listings.entries()) {
    const pool = poolFor(slugById.get(l.categoryId));
    const lead = pool[i % pool.length]!;
    const second = pool[(i + 1) % pool.length]!;
    const hasBroken = l.galleryUrls.some(isBroken) || l.galleryUrls.length === 0;
    if (!hasBroken) continue;
    const gallery = Array.from(new Set([lead, second, ...keepGood(l.galleryUrls)])).slice(0, 3);
    await database.update(productListings).set({ galleryUrls: gallery }).where(eq(productListings.id, l.id));
    galleryFixed++;
  }
  console.log(`  → fixed ${galleryFixed} listing galleries`);

  /**
   * 3. Variants — strip dead URLs only. Never invent one.
   *
   * An EMPTY `imageUrls` is a valid, meaningful state: it means "this variant has
   * no photo of its own, show the listing's". Every reader already does exactly
   * that — the consumer app resolves `variant.imageUrls[0] ?? listing.galleryUrls[0]`,
   * and the card projection follows the same order.
   *
   * This step used to fill an empty set with a stock pool photo so colour swatches
   * would change the lead shot in the demo catalogue. The cost of that was not
   * worth it: because the variant image WINS over the gallery, a fabricated stock
   * photo permanently hid the real one for every listing a retailer had actually
   * uploaded photos to. A men's shirt shipped with a women's cargo-pants shot on
   * every browse, search and product page, while its genuine photo sat unused in
   * the gallery. Leaving the set empty makes the fallback do the obvious thing.
   */
  let variantFixed = 0;
  for (const l of listings) {
    const rows = await database.query.variants.findMany({
      where: eq(variants.listingId, l.id),
      columns: { id: true, imageUrls: true },
    });
    for (const v of rows) {
      if (!v.imageUrls.some(isBroken)) continue;
      await database
        .update(variants)
        .set({ imageUrls: keepGood(v.imageUrls) })
        .where(eq(variants.id, v.id));
      variantFixed++;
    }
  }
  console.log(`  → cleaned ${variantFixed} variant image sets`);
}

// Standalone entry: npx tsx src/db/seed/fix-images.ts
const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('fix-images.ts');
if (isMain) {
  fixImages(db)
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
