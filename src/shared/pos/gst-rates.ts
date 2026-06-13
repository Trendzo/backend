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

type GstKind = 'apparel' | 'footwear' | 'accessory';

/** Category slugs (catalog-defaults.ts) that are footwear. */
const FOOTWEAR_SLUGS = new Set(['footwear']);
/** Category slugs that are accessories. */
const ACCESSORY_SLUGS = new Set(['accessories']);
// Everything else (apparel, her-*, him-* garment sub-categories) is apparel-kind.

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
  if (chapter.startsWith('61') || chapter.startsWith('62')) return 'apparel';
  // No usable HSN — fall back to category slug.
  if (categorySlug && FOOTWEAR_SLUGS.has(categorySlug)) return 'footwear';
  if (categorySlug && ACCESSORY_SLUGS.has(categorySlug)) return 'accessory';
  return 'apparel';
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
  if (FOOTWEAR_SLUGS.has(categorySlug)) return '6403';
  if (ACCESSORY_SLUGS.has(categorySlug)) return '4202';
  // Apparel & garment sub-categories. Knitted (chapter 61) is the common default for tops/tees;
  // woven (62) covers shirts/trousers/dresses. We default to 61 — retailer overrides as needed.
  if (categorySlug === 'apparel') return '6109';
  if (categorySlug.includes('shirt')) return categorySlug.includes('tshirt') ? '6109' : '6205';
  if (categorySlug.includes('dress')) return '6204';
  if (categorySlug.includes('bottom')) return '6203';
  if (categorySlug.includes('top')) return '6109';
  return '6109';
}
