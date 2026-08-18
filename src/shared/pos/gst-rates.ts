/**
 * Authoritative GST rate + HSN defaults for ClosetX retail (apparel / footwear / accessories).
 *
 * This is the ONE table the platform owns so retailers never type HSN or tax rates. Rates here
 * reflect the GST 2.0 reform effective 22-Sep-2025:
 *   - Apparel & footwear: 5% up to ₹2,500/piece, 18% above.   (was ≤₹1,000 → 5%, >₹1,000 → 12%)
 *   - Accessories are flat by item type, NOT price-slab:
 *       bags / belts / wallets (leather, HSN 4202/4203)  → 18%
 *       sunglasses (HSN 9004)                            → 18%
 *       imitation / artificial jewellery (HSN 7117)      → 12%
 *       fine (gold/silver) jewellery (HSN 7113)          → 3%
 *
 * Rate resolution prefers an explicit HSN when it maps to a known code; otherwise it falls back
 * to the product's category. Apparel/footwear are always price-slab (the HSN chapter alone can't
 * tell us which slab — that depends on MRP), so for those kinds the MRP decides.
 *
 * NOTE: apparel & footwear ₹2,500 thresholds are high-confidence (PIB / multiple sources).
 * Accessory rates are single-source — confirm with a CA before relying on them in production,
 * especially fine-jewellery (3%, a separate chapter with its own rules).
 */

import { canonicalCategorySlug } from '@/shared/catalog/taxonomy.js';

/** GST rate in basis points (1% = 100bp). */
export const GstRateBp = {
  zero: 0,
  fine_jewellery: 300, // 3%
  reduced: 500, // 5% — apparel/footwear ≤ slab
  imitation_jewellery: 1200, // 12%
  standard: 1800, // 18% — apparel/footwear > slab, leather goods, sunglasses
} as const;

/** Apparel & footwear price slab: at or below this MRP/piece the reduced (5%) rate applies. */
export const APPAREL_FOOTWEAR_SLAB_PAISE = 250_000; // ₹2,500

type GstKind = 'apparel' | 'footwear' | 'accessory' | 'cosmetics';

/**
 * Category slugs are two-level (`@/shared/catalog/taxonomy.ts`): a parent like `shoes` or
 * `accessories`, and leaves named `<parent>-<leaf>` such as `shoes-sneakers` or
 * `accessories-sunglasses`. Listings always carry the LEAF slug, so classification strips
 * the last segment to get the parent and looks the kind up there.
 *
 * This replaced substring matching on the old flat slugs, which silently mis-classified
 * the new ones — `denim-jeans` matched none of the old `shirt`/`dress`/`bottom`/`top`
 * probes and fell through to the knitwear default.
 */
const parentOf = (slug: string): string => {
  const cut = slug.lastIndexOf('-');
  return cut === -1 ? slug : slug.slice(0, cut);
};

/** Parent slug → GST kind. Anything unlisted is apparel (the common case). */
const KIND_BY_PARENT: Record<string, GstKind> = {
  shoes: 'footwear',
  bags: 'accessory',
  accessories: 'accessory',
  'jewelry': 'accessory',
  beauty: 'cosmetics',
  // Legacy flat slugs, still reachable via order/POS snapshots taken before the retaxonomy.
  footwear: 'footwear',
  apparel: 'apparel',
};

/**
 * Leaves that don't take their parent's kind. Socks, tights and scarves sit under
 * Accessories on the rail but are knitted/woven textiles for tax purposes (chapter 61/62),
 * so they follow the apparel price slab rather than the flat 18%.
 */
const KIND_BY_LEAF: Record<string, GstKind> = {
  'accessories-socks': 'apparel',
  'accessories-tights': 'apparel',
  'accessories-scarves': 'apparel',
};

/**
 * Resolve a category slug (leaf or parent) to its GST kind.
 *
 * Normalised first because order items, POS sales and invoices snapshot the category
 * slug AT THE TIME OF SALE. Those historical rows still carry the gender-prefixed slugs,
 * and a miss here silently falls through to 'apparel' — which would change the tax kind
 * on a jewellery or footwear line when a return or credit note is computed later.
 */
function kindForSlug(slug: string): GstKind {
  const s = canonicalCategorySlug(slug);
  return KIND_BY_LEAF[s] ?? KIND_BY_PARENT[s] ?? KIND_BY_PARENT[parentOf(s)] ?? 'apparel';
}

/** Classify a line into a GST kind from its category slug + HSN. HSN wins when recognisable. */
function classify(hsn: string | null, categorySlug: string | null): GstKind {
  const chapter = hsn?.replace(/\D/g, '').slice(0, 4) ?? '';
  if (chapter.startsWith('6403') || chapter.startsWith('6404') || chapter.startsWith('6405')) {
    return 'footwear';
  }
  if (
    chapter.startsWith('4202') ||
    chapter.startsWith('4203') ||
    chapter.startsWith('9004') ||
    chapter.startsWith('7117') ||
    chapter.startsWith('7113')
  ) {
    return 'accessory';
  }
  if (chapter.startsWith('3303') || chapter.startsWith('3304') || chapter.startsWith('3305')) {
    return 'cosmetics';
  }
  if (chapter.startsWith('61') || chapter.startsWith('62')) return 'apparel';
  // No usable HSN — fall back to the category slug's kind.
  return categorySlug ? kindForSlug(categorySlug) : 'apparel';
}

/** Accessory rate from a 4-digit HSN chapter; defaults to 18% (the common bags/belts/sunglasses case). */
function accessoryRateBp(hsn: string | null): number {
  const chapter = hsn?.replace(/\D/g, '').slice(0, 4) ?? '';
  if (chapter.startsWith('7113')) return GstRateBp.fine_jewellery; // 3%
  if (chapter.startsWith('7117')) return GstRateBp.imitation_jewellery; // 12%
  return GstRateBp.standard; // 4202/4203/9004 and unknown accessories → 18%
}

/** Apparel/footwear price slab: ≤ ₹2,500 → 5%, above → 18%. */
function slabRateBp(unitMrpPaise: number): number {
  return unitMrpPaise > APPAREL_FOOTWEAR_SLAB_PAISE ? GstRateBp.standard : GstRateBp.reduced;
}

/**
 * Resolve the GST rate (basis points) for a sale line. Prefers an explicit HSN; otherwise uses
 * the category slug. Apparel & footwear are price-slab on MRP; accessories are flat by type.
 */
export function resolveGstRateBp(input: {
  hsn: string | null;
  categorySlug: string | null;
  unitMrpPaise: number;
}): number {
  const kind = classify(input.hsn, input.categorySlug);
  switch (kind) {
    case 'accessory':
      return accessoryRateBp(input.hsn);
    case 'cosmetics':
      // Cosmetics & toiletries (chapter 33) are flat 18% — no price slab. Previously
      // these fell through to apparel, so a ₹800 lipstick was taxed at 5%.
      return GstRateBp.standard;
    case 'footwear':
    case 'apparel':
      return slabRateBp(input.unitMrpPaise);
  }
}

/**
 * Default 4-digit HSN for a category slug, used to pre-fill a listing's HSN when the retailer
 * leaves it blank. Advisory only — the retailer can override, and the value is nullable so it
 * never blocks listing creation. 4-digit is sufficient for B2C supplies below the ₹5cr turnover.
 */
export function categoryDefaultHsn(categorySlug: string | null): string | null {
  if (!categorySlug) return null;
  // Normalised for the same reason as kindForSlug: historical snapshots carry the old
  // gender-prefixed slugs.
  const slug = canonicalCategorySlug(categorySlug);
  const leafHit = HSN_BY_LEAF[slug];
  if (leafHit) return leafHit;
  return HSN_BY_PARENT[slug] ?? HSN_BY_PARENT[parentOf(slug)] ?? '6109';
}

/**
 * Default HSN per taxonomy parent. Knitted (chapter 61) is the common default for
 * tops/tees; woven (62) covers shirts, trousers and dresses.
 */
const HSN_BY_PARENT: Record<string, string> = {
  tops: '6109',
  bottoms: '6203',
  denim: '6203',
  outerwear: '6201',
  active: '6112',
  lounge: '6208',
  swim: '6112',
  shoes: '6403',
  bags: '4202',
  accessories: '4202',
  beauty: '3304',
  'dresses': '6204',
  'coords': '6204',
  'jewelry': '7117',
  'ethnic': '6205',
  'formal': '6203',
  // Legacy flat slugs, kept so pre-retaxonomy snapshots still resolve.
  apparel: '6109',
  footwear: '6403',
};

/** Leaves whose HSN differs from their parent's default. */
const HSN_BY_LEAF: Record<string, string> = {
  'tops-shirts': '6205',
  'tops-sweaters': '6110',
  'tops-cardigans': '6110',
  'bottoms-skirts': '6204',
  'denim-jackets': '6201',
  'accessories-sunglasses': '9004',
  'accessories-watches': '9102',
  'accessories-belts': '4203',
  'accessories-wallets': '4202',
  'accessories-socks': '6115',
  'accessories-tights': '6115',
  'accessories-scarves': '6214',
  'accessories-caps': '6505',
  'accessories-hats': '6505',
  'formal-shirts': '6205',
  'beauty-fragrance': '3303',
  'beauty-hair': '3305',
};
