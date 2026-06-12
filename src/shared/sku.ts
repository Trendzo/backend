/**
 * SKU generation. SKUs are unique store-wide (enforced by a partial unique
 * index on variants (storeId, sku)). When a retailer omits a SKU we generate a
 * readable, store-unique one: `BRAND-NAME-ATTR-XXXX`.
 */

/** Uppercase, strip to alphanumerics, collapse runs to a single dash, truncate. */
function slugForSku(input: string, maxLen: number): string {
  const s = input
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '');
  return s;
}

/** Short pseudo-random base36 suffix. Deterministic randomness isn't needed here. */
function randomSuffix(len = 4): string {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += Math.floor(Math.random() * 36).toString(36).toUpperCase();
  }
  return out;
}

export type SkuParts = {
  brand?: string | null;
  name: string;
  attributesLabel?: string | null;
};

/**
 * Generate a SKU that does not collide store-wide.
 *
 * @param parts   human-readable seeds (brand / product name / variant label)
 * @param exists  async predicate: does this SKU already exist for the store?
 *                (caller binds it to the store + an optional excluded variant)
 * @param taken   optional in-memory set of SKUs already allocated in the current
 *                batch (so a bulk insert doesn't generate two identical SKUs
 *                before any of them hit the DB)
 */
export async function generateSku(
  parts: SkuParts,
  exists: (sku: string) => Promise<boolean>,
  taken?: Set<string>,
): Promise<string> {
  const brand = parts.brand ? slugForSku(parts.brand, 6) : '';
  const name = slugForSku(parts.name, 10);
  const attr = parts.attributesLabel ? slugForSku(parts.attributesLabel, 8) : '';
  const base = [brand, name, attr].filter(Boolean).join('-') || 'SKU';

  for (let attempt = 0; attempt < 12; attempt++) {
    // First few attempts keep the suffix short; widen on repeated collisions.
    const candidate = `${base}-${randomSuffix(attempt < 6 ? 4 : 8)}`;
    if (taken?.has(candidate)) continue;
    if (!(await exists(candidate))) {
      taken?.add(candidate);
      return candidate;
    }
  }
  // Extremely unlikely fallback: timestamp-ish long token, still checked once.
  const fallback = `${base}-${randomSuffix(10)}`;
  taken?.add(fallback);
  return fallback;
}
