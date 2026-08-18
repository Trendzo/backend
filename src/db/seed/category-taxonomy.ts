/* eslint-disable no-console -- CLI seed: console output is the intended UX */
/**
 * Seed the two-level category tree and migrate the flat pre-taxonomy catalog onto it.
 *
 * The tree itself lives in `@/shared/catalog/taxonomy.ts` (pure data). This file does the
 * database work in four passes:
 *   1. parents  — must land first; the self-FK is ON DELETE no action
 *   2. leaves   — parentId resolved from pass 1
 *   3. remap    — move the 66 `consumer-catalog.ts` listings onto their new leaves
 *   4. retire   — delete the flat legacy categories, but only once unreferenced
 *
 * Idempotent: keyed on slug, and unlike `consumer-catalog.ts` (which only backfills rows
 * whose imageUrl is falsy) it also UPDATES existing rows, so re-running after an edit to
 * the taxonomy actually converges.
 *
 * `imageUrl` is deliberately left untouched — `fix-images.ts` owns category art and runs last.
 */

import { eq, inArray, sql } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { categories, productListings } from '@/db/schema/index.js';
import type { Gender } from '@/shared/catalog/taxonomy.js';
import { LEGACY_CATEGORY_SLUGS, TAXONOMY, leafSlug, parentSlug } from '@/shared/catalog/taxonomy.js';
import { IdPrefix, newId } from '@/shared/ids.js';

/**
 * Where each of the 66 listings seeded by `consumer-catalog.ts` moves to. Hand-authored
 * rather than keyword-matched so the demo catalog lands in sensible leaves; a keyword
 * pass would put "Cargo Joggers" under Cargos and "Track Pants" under Bottoms.
 *
 * Unisex listings are deliberately routed to UNISEX leaves (Raw Denim Jeans → denim-jeans,
 * Canvas High-Top → shoes-sneakers) so they keep showing on both rails.
 *
 * `consumer-catalog.ts` imports this too, so a FRESH database seeds these listings straight
 * onto the right leaf and an EXISTING one gets moved — one table, both directions.
 */
export const LISTING_REMAP: Record<string, string> = {
  // HER — dresses
  'Silk Slip Dress': 'dresses-midi',
  'Floral Maxi Dress': 'dresses-maxi',
  'Elegant Mini Dress': 'dresses-mini',
  'Satin Wrap Dress': 'dresses-party',
  'Pleated Midi Dress': 'dresses-midi',
  'Boho Maxi Dress': 'dresses-maxi',
  'Sunset Tiered Maxi': 'dresses-maxi',
  'Cotton Slub Maxi': 'dresses-maxi',
  // HER — tops
  'Crop Top': 'tops-crop-tops',
  'Silk Camisole': 'tops-camis',
  'Ribbed Knit Top': 'tops-sweaters',
  'Off-Shoulder Blouse': 'tops-blouses',
  // HER — bottoms
  'High-Waist Skinny Jeans': 'denim-skinny',
  'Pleated Mini Skirt': 'bottoms-skirts',
  'Wide-Leg Trousers': 'bottoms-wide-leg',
  // HER — shoes / bags / beauty / coats
  'Block Heels': 'shoes-heels',
  'Strappy Stilettos': 'shoes-heels',
  'Nude Pumps': 'shoes-heels',
  'Designer Tote': 'bags-totes',
  'Quilted Shoulder Bag': 'bags-shoulder',
  'Mini Crossbody': 'bags-crossbody',
  'Velvet Matte Lipstick': 'beauty-makeup',
  'Rose Glow Palette': 'beauty-makeup',
  'Oversized Wool Coat': 'outerwear-coats',
  'Belted Trench Coat': 'outerwear-trench',
  'Faux Fur Coat': 'outerwear-coats',
  // HIM — tops
  'Slim Fit Oxford Shirt': 'tops-shirts',
  'Linen Summer Shirt': 'tops-shirts',
  'Flannel Check Shirt': 'tops-shirts',
  'Black Dress Shirt': 'formal-shirts',
  'Graphic Oversized Tee': 'tops-tshirts',
  'Essential Crew Tee': 'tops-tshirts',
  'Classic Polo Shirt': 'tops-polos',
  'Dry-Fit Training Tee': 'active-gym-tees',
  // HIM — bottoms
  'Slim Wash Denim': 'denim-slim',
  'Cargo Joggers': 'bottoms-joggers',
  'Tailored Chinos': 'bottoms-chinos',
  'Track Pants': 'active-track-pants',
  // HIM — outerwear
  'Bomber Jacket': 'outerwear-bombers',
  'Denim Trucker Jacket': 'denim-jackets',
  'Puffer Jacket': 'outerwear-puffers',
  'Leather Biker Jacket': 'outerwear-jackets',
  'Wool Overcoat': 'outerwear-coats',
  'Mac Trench Coat': 'outerwear-coats',
  // HIM — shoes / accessories
  'Court Sneaker': 'shoes-sneakers',
  'Air Max Runner': 'shoes-sneakers',
  'Retro Suede Sneaker': 'shoes-sneakers',
  'Classic White Sneaker': 'shoes-sneakers',
  'Chrono Steel Watch': 'accessories-watches',
  'Minimal Leather Watch': 'accessories-watches',
  'Sport Digital Watch': 'accessories-watches',
  'Aviator Sunglasses': 'accessories-sunglasses',
  // UNISEX — every target below is a unisex leaf so both rails keep these
  'Cotton Jogger Pants': 'active-track-pants',
  'Printed Oversized Tee': 'tops-tshirts',
  'Fleece Hoodie': 'tops-hoodies',
  'Zip-Up Track Jacket': 'active-windbreakers',
  'Relaxed Sweatshirt': 'tops-sweatshirts',
  'Raw Denim Jeans': 'denim-jeans',
  'Canvas High-Top': 'shoes-sneakers',
  'Skate Classic': 'shoes-sneakers',
  '574 Core Runner': 'shoes-sneakers',
  'Slip-On Sneaker': 'shoes-sneakers',
  'Canvas Tote': 'bags-totes',
  'Baseball Cap': 'accessories-caps',
  'Sport Socks 3-Pack': 'accessories-socks',
  'Classic Backpack': 'bags-backpacks',
};

/**
 * Where anything still sitting on a flat slug goes, by slug rather than by name.
 *
 * LISTING_REMAP only knows the 66 hand-written products. A real database also holds
 * listings from `demo-retailer.ts`, `seed-kaush*.ts` and whatever retailers created — on
 * the dev database that is another ~35. Without this they'd stay on a retired category,
 * which blocks the delete AND hides them from browse (a parent with no children is
 * filtered off the rail). Applied after the name pass, so it only catches leftovers.
 */
const FALLBACK_REMAP: Record<string, string> = {
  apparel: 'tops-tshirts',
  footwear: 'shoes-sneakers',
  accessories: 'accessories-belts',
  'her-tops': 'tops-blouses',
  'her-bottoms': 'bottoms-trousers',
  'her-heels': 'shoes-heels',
  'her-bags': 'bags-totes',
  'her-beauty': 'beauty-makeup',
  'her-coats': 'outerwear-coats',
  'her-maxi': 'dresses-maxi',
  'him-shirts': 'tops-shirts',
  'him-tshirts': 'tops-tshirts',
  'him-bottoms': 'bottoms-trousers',
  'him-jackets': 'outerwear-jackets',
  'him-sneakers': 'shoes-sneakers',
  'him-watches': 'accessories-watches',
  'him-coats': 'outerwear-coats',
  'him-eyewear': 'accessories-sunglasses',
};

/**
 * The flat pre-taxonomy slugs. `accessories` and `her-dresses` are NOT here — the first
 * is reused as a node of the new tree, and the second IS the Dresses parent, renamed to
 * `dresses` by the slug-rename pass rather than retired.
 */
const RETIRED_SLUGS = [
  'apparel',
  'footwear',
  'her-tops',
  'her-bottoms',
  'her-heels',
  'her-bags',
  'her-beauty',
  'her-coats',
  'her-maxi',
  'him-shirts',
  'him-tshirts',
  'him-bottoms',
  'him-jackets',
  'him-sneakers',
  'him-watches',
  'him-coats',
  'him-eyewear',
];

export async function seedCategoryTaxonomy(database: typeof Db): Promise<void> {
  const idBySlug = new Map<string, string>();

  /**
   * Slugs lost their gender prefix. Rename the EXISTING rows in place before anything
   * upserts, so ids survive and every listing keeps its category.
   *
   * Doing this by upsert instead would insert fresh `dresses-mini` rows while the
   * listings stayed pointed at `her-dresses-mini`, leaving the old node undeletable and
   * its products invisible — a parent with no children is filtered off the rail.
   */
  for (const [oldSlug, newSlug] of Object.entries(LEGACY_CATEGORY_SLUGS)) {
    const stale = await database.query.categories.findFirst({
      where: eq(categories.slug, oldSlug),
      columns: { id: true },
    });
    if (!stale) continue;
    const taken = await database.query.categories.findFirst({
      where: eq(categories.slug, newSlug),
      columns: { id: true },
    });
    // A previous run already created the new row; drop the rename and let the upsert
    // converge, rather than colliding with categories_slug_idx.
    if (taken) continue;
    await database.update(categories).set({ slug: newSlug }).where(eq(categories.id, stale.id));
    console.log(`  → renamed category ${oldSlug} → ${newSlug}`);
  }

  /** Insert or converge one row. Image URL is never touched — fix-images.ts owns it. */
  async function upsert(row: {
    slug: string;
    label: string;
    labelHim: string | null;
    gender: Gender;
    parentId: string | null;
    iconName: string | null;
    tintColor: string | null;
    sortOrder: number;
    sortOrderHim: number | null;
  }): Promise<string> {
    const existing = await database.query.categories.findFirst({
      where: eq(categories.slug, row.slug),
      columns: { id: true },
    });
    if (existing) {
      await database
        .update(categories)
        .set({
          label: row.label,
          labelHim: row.labelHim,
          gender: row.gender,
          parentId: row.parentId,
          iconName: row.iconName,
          tintColor: row.tintColor,
          sortOrder: row.sortOrder,
          sortOrderHim: row.sortOrderHim,
          isActive: true,
        })
        .where(eq(categories.id, existing.id));
      idBySlug.set(row.slug, existing.id);
      return existing.id;
    }
    const id = newId(IdPrefix.Category);
    await database.insert(categories).values({ id, isActive: true, ...row });
    idBySlug.set(row.slug, id);
    return id;
  }

  // Pass 1 — parents. Must land before leaves: the self-FK is ON DELETE no action and
  // a leaf's parentId has to resolve to a row that already exists.
  for (const p of TAXONOMY) {
    await upsert({
      slug: parentSlug(p),
      label: p.label,
      labelHim: p.labelHim ?? null,
      gender: p.gender,
      parentId: null,
      iconName: p.iconName,
      tintColor: p.tintColor,
      sortOrder: p.sortOrder,
      sortOrderHim: p.sortOrderHim ?? null,
    });
  }

  // Pass 2 — leaves.
  let leafCount = 0;
  for (const p of TAXONOMY) {
    const pid = idBySlug.get(parentSlug(p))!;
    for (const l of p.leaves) {
      await upsert({
        slug: leafSlug(p, l.key),
        label: l.label,
        labelHim: null,
        gender: l.gender ?? p.gender,
        parentId: pid,
        iconName: p.iconName,
        tintColor: p.tintColor,
        sortOrder: l.sortOrder,
        sortOrderHim: l.sortOrderHim ?? null,
      });
      leafCount += 1;
    }
  }
  console.log(`  → taxonomy: ${TAXONOMY.length} parents + ${leafCount} leaves`);

  // Pass 3 — move existing listings off the flat slugs onto their new leaves. Keyed by
  // listing name because that is what the consumer-catalog seed guarantees is stable.
  let moved = 0;
  for (const [name, slug] of Object.entries(LISTING_REMAP)) {
    const target = idBySlug.get(slug);
    if (!target) {
      console.warn(`  ! remap: unknown target slug '${slug}' for "${name}"`);
      continue;
    }
    const res = await database
      .update(productListings)
      .set({ categoryId: target })
      .where(
        sql`${productListings.name} = ${name} AND ${productListings.categoryId} <> ${target}`,
      );
    moved += res.rowCount ?? 0;
  }
  if (moved > 0) console.log(`  → remapped ${moved} listing(s) onto taxonomy leaves`);

  // Pass 3b — anything still on a flat slug (demo/retailer-created listings the name map
  // doesn't know) moves by slug, so no listing is left on a category about to disappear.
  let swept = 0;
  for (const [oldSlug, newSlug] of Object.entries(FALLBACK_REMAP)) {
    const target = idBySlug.get(newSlug);
    const source = await database.query.categories.findFirst({
      where: eq(categories.slug, oldSlug),
      columns: { id: true },
    });
    if (!target || !source || source.id === target) continue;
    const res = await database
      .update(productListings)
      .set({ categoryId: target })
      .where(eq(productListings.categoryId, source.id));
    swept += res.rowCount ?? 0;
  }
  if (swept > 0) console.log(`  → swept ${swept} further listing(s) off the flat categories`);

  // Pass 4 — retire the flat categories, but only once nothing references them. A
  // retailer-created listing we don't know about must never be orphaned (the FK is
  // ON DELETE no action, so this would throw anyway — we'd rather report it).
  const stale = await database.query.categories.findMany({
    where: inArray(categories.slug, RETIRED_SLUGS),
    columns: { id: true, slug: true },
  });
  for (const c of stale) {
    const [refs] = await database
      .select({ n: sql<number>`count(*)::int` })
      .from(productListings)
      .where(eq(productListings.categoryId, c.id));
    if ((refs?.n ?? 0) > 0) {
      console.warn(
        `  ! keeping legacy category '${c.slug}' — ${refs?.n} listing(s) still reference it`,
      );
      continue;
    }
    await database.delete(categories).where(eq(categories.id, c.id));
    console.log(`  → retired legacy category '${c.slug}'`);
  }
}
