/* eslint-disable no-console -- CLI seed: console output is the intended UX */
/**
 * Fill every taxonomy leaf with products.
 *
 * The consumer app's browse screen renders ~118 sub-category tiles per the design, but the
 * hand-written `consumer-catalog.ts` catalog is only 66 listings spread over a dozen
 * leaves. Without this, most tiles open an empty grid. This generates 3 listings per leaf
 * (~354) from templates so the demo catalog looks like a real store.
 *
 * Everything is DERIVED FROM THE INDEX — no `Math.random()`, no `Date.now()` — so two runs
 * against two databases produce identical catalogs, and re-running is a no-op: ids are
 * deterministic (`lst_gen_<slug>_<n>`), so existing rows are skipped rather than duplicated.
 *
 * Images are deliberately left empty; `fix-images.ts` runs last and fills gallery/variant
 * art from the per-parent Unsplash pools.
 *
 * Run standalone: npx tsx src/db/seed/catalog-expand.ts
 */

import { and, eq, inArray, ne } from 'drizzle-orm';
import { db } from '@/db/client.js';
import type { db as Db } from '@/db/client.js';
import {
  categories,
  productListings,
  retailerStores,
  variantGroups,
  variants,
} from '@/db/schema/index.js';
import { TAXONOMY, leafSlug, parentSlug } from '@/shared/catalog/taxonomy.js';
import { categoryDefaultHsn } from '@/shared/pos/gst-rates.js';

const paise = (rupees: number) => Math.round(rupees * 100);

/** Per-listing name prefixes. Rotated by index so a leaf's three products differ. */
const PREFIXES = [
  'Essential',
  'Classic',
  'Relaxed',
  'Premium',
  'Everyday',
  'Signature',
  'Heritage',
  'Modern',
  'Tailored',
  'Vintage',
];

const COLORS: { name: string; hex: string }[] = [
  { name: 'Black', hex: '#151515' },
  { name: 'Ivory', hex: '#F6F2EA' },
  { name: 'Navy', hex: '#1F2A44' },
  { name: 'Olive', hex: '#5A6247' },
  { name: 'Sand', hex: '#D8C3A5' },
  { name: 'Rust', hex: '#A6482E' },
  { name: 'Slate', hex: '#5C6672' },
  { name: 'Blush', hex: '#EBC7C7' },
];

/** Labels that read wrong in the singular — pluralia tantum, plus footwear. */
const KEEP_PLURAL = new Set([
  'Pants', 'Trousers', 'Jeans', 'Shorts', 'Leggings', 'Joggers', 'Chinos', 'Cargos',
  'Cargo Pants', 'Tights', 'Socks', 'Boxers', 'Briefs', 'Sunglasses', 'Skinny Jeans',
  'Wide-Leg Jeans', 'Baggy Jeans', 'Slim Jeans', 'Denim Shorts', 'Swim Shorts',
  'Track Pants', 'Lounge Pants', 'Gym Leggings', 'Formal Trousers', 'Earrings', 'Nails',
  'Sneakers', 'Heels', 'Boots', 'Flats', 'Sandals', 'Loafers', 'Formal Shoes',
]);

const IRREGULAR: Record<string, string> = { Hoodies: 'Hoodie', Scarves: 'Scarf' };

/** "Mini Dresses" → "Mini Dress", so generated names read like product names. */
function singular(label: string): string {
  if (KEEP_PLURAL.has(label)) return label;
  if (IRREGULAR[label]) return IRREGULAR[label];
  // -es is only a plural suffix after a sibilant the word already ended in:
  // Dresses→Dress, Clutches→Clutch. NOT Blouses, whose stem ends in a silent e —
  // stripping two there gives "Blous".
  if (/(sses|ches|shes|xes|zes)$/.test(label)) return label.slice(0, -2);
  if (label.endsWith('ies')) return `${label.slice(0, -3)}y`;
  if (label.endsWith('s') && !label.endsWith('ss')) return label.slice(0, -1);
  return label;
}

type SizeKind = 'letter' | 'waist' | 'shoe' | 'one';

/** Sizing + price band + occasions, per taxonomy parent. */
const PARENT_PROFILE: Record<
  string,
  { sizes: SizeKind; priceFrom: number; priceTo: number; occ: string[] }
> = {
  tops: { sizes: 'letter', priceFrom: 799, priceTo: 2499, occ: ['brunch', 'office'] },
  bottoms: { sizes: 'waist', priceFrom: 1299, priceTo: 3499, occ: ['office', 'streetwear'] },
  denim: { sizes: 'waist', priceFrom: 1999, priceTo: 4999, occ: ['streetwear', 'travel'] },
  lounge: { sizes: 'letter', priceFrom: 699, priceTo: 1999, occ: ['travel'] },
  active: { sizes: 'letter', priceFrom: 999, priceTo: 2999, occ: ['gym'] },
  swim: { sizes: 'letter', priceFrom: 899, priceTo: 2499, occ: ['beach'] },
  outerwear: { sizes: 'letter', priceFrom: 2499, priceTo: 8999, occ: ['travel', 'office'] },
  shoes: { sizes: 'shoe', priceFrom: 1499, priceTo: 6999, occ: ['streetwear', 'travel'] },
  bags: { sizes: 'one', priceFrom: 999, priceTo: 5999, occ: ['brunch', 'travel'] },
  accessories: { sizes: 'one', priceFrom: 499, priceTo: 2999, occ: ['streetwear'] },
  beauty: { sizes: 'one', priceFrom: 399, priceTo: 2499, occ: ['date', 'party'] },
  'her-dresses': { sizes: 'letter', priceFrom: 1499, priceTo: 5999, occ: ['party', 'date'] },
  'her-coords': { sizes: 'letter', priceFrom: 1999, priceTo: 4999, occ: ['brunch', 'party'] },
  'her-jewelry': { sizes: 'one', priceFrom: 599, priceTo: 3999, occ: ['party', 'wedding'] },
  'him-ethnic': { sizes: 'letter', priceFrom: 1999, priceTo: 6999, occ: ['wedding', 'formal'] },
  'him-formal': { sizes: 'waist', priceFrom: 2999, priceTo: 9999, occ: ['formal', 'office'] },
};

const SIZE_RUNS: Record<SizeKind, string[]> = {
  letter: ['XS', 'S', 'M', 'L', 'XL'],
  waist: ['28', '30', '32', '34', '36'],
  shoe: ['UK 6', 'UK 7', 'UK 8', 'UK 9', 'UK 10'],
  one: ['Free Size'],
};

/** Generated ids are stable across runs, which is what makes re-seeding idempotent. */
const genId = (kind: string, slug: string, n: number, extra = '') =>
  `${kind}_gen_${slug.replace(/-/g, '')}_${n}${extra}`;

const PER_LEAF = 3;

export async function seedCatalogExpand(database: typeof Db): Promise<void> {
  const store = await database.query.retailerStores.findFirst({
    where: eq(retailerStores.status, 'active'),
    columns: { id: true },
  });
  if (!store) {
    console.warn('  ! no active store — run the consumer catalog seed first, skipping expansion');
    return;
  }

  const brandRows = await database.query.brands.findMany({ columns: { id: true } });
  if (brandRows.length === 0) {
    console.warn('  ! no brands — run catalog defaults first, skipping expansion');
    return;
  }

  const leafSlugs = TAXONOMY.flatMap((p) => p.leaves.map((l) => leafSlug(p, l.key)));
  const catRows = await database.query.categories.findMany({
    where: inArray(categories.slug, leafSlugs),
    columns: { id: true, slug: true },
  });
  const catIdBySlug = new Map(catRows.map((c) => [c.slug, c.id]));

  // Skip rows that already exist rather than relying on onConflictDoNothing, so the
  // variant/group inserts below don't run for listings that are already seeded.
  const existing = new Set(
    (
      await database.query.productListings.findMany({ columns: { id: true } })
    ).map((l) => l.id),
  );

  const listingValues: (typeof productListings.$inferInsert)[] = [];
  const groupValues: (typeof variantGroups.$inferInsert)[] = [];
  const variantValues: (typeof variants.$inferInsert)[] = [];
  const renames: { id: string; name: string }[] = [];

  let n = 0; // global counter — drives every "random-looking" choice
  for (const p of TAXONOMY) {
    const pSlug = parentSlug(p);
    const profile = PARENT_PROFILE[pSlug];
    if (!profile) {
      console.warn(`  ! no profile for parent '${pSlug}', skipping its leaves`);
      continue;
    }
    for (const leaf of p.leaves) {
      const slug = leafSlug(p, leaf.key);
      const categoryId = catIdBySlug.get(slug);
      if (!categoryId) {
        console.warn(`  ! category '${slug}' not seeded, skipping`);
        continue;
      }
      const noun = singular(leaf.label);
      const sizes = SIZE_RUNS[profile.sizes];

      for (let i = 0; i < PER_LEAF; i++) {
        n += 1;
        const listingId = genId('lst', slug, i);
        const name = `${PREFIXES[n % PREFIXES.length]} ${noun}`;
        if (existing.has(listingId)) {
          // Already seeded. Names are derived, so an edit to the templates here should
          // reach rows that exist rather than being silently skipped forever.
          renames.push({ id: listingId, name });
          continue;
        }

        // Spread prices across the band deterministically: low, middle, high.
        const price =
          profile.priceFrom +
          Math.round(((profile.priceTo - profile.priceFrom) * i) / Math.max(1, PER_LEAF - 1));
        // Every third listing carries a strike-through price, so discount badges appear.
        const compare = n % 3 === 0 ? Math.round(price * 1.4) : undefined;
        const colorCount = 1 + (n % 2); // 1 or 2 colourways

        listingValues.push({
          id: listingId,
          storeId: store.id,
          brandId: brandRows[n % brandRows.length]!.id,
          categoryId,
          name,
          description: `${name} — ${leaf.label.toLowerCase()} cut for everyday wear, finished with a clean silhouette and durable stitching.`,
          gender: leaf.gender ?? p.gender,
          listingPolicy: 'return',
          galleryUrls: [],
          occasion: profile.occ,
          variantMode: 'color_size',
          status: 'active',
          // 3.6 – 4.8, so `sort=rating` has something to order by.
          ratingAvg: (3.6 + (n % 13) / 10).toFixed(2),
          ratingCount: 8 + ((n * 7) % 240),
          hsn: categoryDefaultHsn(slug),
        });

        // A 'Default' group mirrors what consumer-catalog.ts creates; the shaper only
        // surfaces groups that own variants, so it stays invisible.
        groupValues.push({
          id: genId('vg', slug, i, '_d'),
          listingId,
          storeId: store.id,
          name: 'Default',
          isDefault: true,
        });

        for (let c = 0; c < colorCount; c++) {
          const color = COLORS[(n + c) % COLORS.length]!;
          const groupId = genId('vg', slug, i, `_${c}`);
          groupValues.push({
            id: groupId,
            listingId,
            storeId: store.id,
            name: color.name,
            colorHex: color.hex,
            sortOrder: c,
          });
          for (const [si, size] of sizes.entries()) {
            variantValues.push({
              id: genId('var', slug, i, `_${c}_${si}`),
              listingId,
              storeId: store.id,
              groupId,
              attributes: { size, color: color.name },
              attributesLabel: `${size} / ${color.name}`,
              imageUrls: [],
              stock: 4 + ((n + si * 3) % 18),
              reserved: 0,
              pricePaise: paise(price),
              ...(compare !== undefined && { compareAtPrice: paise(compare) }),
            });
          }
        }
      }
    }
  }

  // Converge names on rows that already exist before deciding there's nothing to do.
  let renamed = 0;
  for (const r of renames) {
    const res = await database
      .update(productListings)
      .set({ name: r.name })
      .where(and(eq(productListings.id, r.id), ne(productListings.name, r.name)));
    renamed += res.rowCount ?? 0;
  }
  if (renamed > 0) console.log(`  → renamed ${renamed} generated listing(s)`);

  if (listingValues.length === 0) {
    console.log('  → catalog already expanded, nothing to add');
    return;
  }

  // Chunked because a single insert of ~3,500 variants blows past the parameter limit.
  const chunk = <T>(rows: T[], size = 200): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
    return out;
  };
  for (const part of chunk(listingValues)) await database.insert(productListings).values(part);
  for (const part of chunk(groupValues)) await database.insert(variantGroups).values(part);
  for (const part of chunk(variantValues)) await database.insert(variants).values(part);

  console.log(
    `  → expanded catalog: ${listingValues.length} listings, ${variantValues.length} variants across ${leafSlugs.length} leaves`,
  );
}

// Standalone entry: npx tsx src/db/seed/catalog-expand.ts
const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('catalog-expand.ts');
if (isMain) {
  seedCatalogExpand(db)
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
