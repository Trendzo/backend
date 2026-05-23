/**
 * Pure classifier for the retailer inventory CSV importer.
 *
 * Input: parsed rows (already Zod-validated) + read-only catalog snapshots.
 * Output: a per-row execution plan plus a summary roll-up. The route handler
 * either renders this as a dry-run preview or feeds it into the apply
 * transaction.
 *
 * No DB writes happen here; everything is in-memory so the function is
 * trivially unit-testable.
 */

export type RawImportRow = {
  sku?: string;
  productName?: string;
  variantLabel?: string;
  attributes?: string;
  brand?: string;
  category?: string;
  gender?: 'her' | 'him' | 'unisex';
  pricePaise?: number;
  stock: number;
};

export type VariantRecord = {
  id: string;
  listingId: string;
  sku: string | null;
  attributesLabel: string;
  attributes: Record<string, string>;
  stock: number;
  reserved: number;
  pricePaise: number;
};

export type ListingRecord = {
  id: string;
  name: string;
  brandId: string | null;
  categoryId: string;
  gender: 'her' | 'him' | 'unisex';
};

export type BrandRecord = { id: string; slug: string; name: string };
export type CategoryRecord = { id: string; slug: string; label: string };

export type ClassifierContext = {
  variants: VariantRecord[];
  listings: ListingRecord[];
  brands: BrandRecord[];
  categories: CategoryRecord[];
};

export type StockUpdatePlan = {
  variantId: string;
  sku: string | null;
  currentStock: number;
  newStock: number;
  delta: number;
  currentPricePaise: number;
  /** Present only when the row's pricePaise differs from current. */
  newPricePaise?: number;
};

export type VariantCreatePlan = {
  listingId: string;
  listingName: string;
  attributes: Record<string, string>;
  attributesLabel: string;
  sku?: string;
  pricePaise: number;
  stock: number;
};

export type ListingCreatePlan = {
  listingName: string;
  brandId: string;
  brandSlug: string;
  categoryId: string;
  categorySlug: string;
  gender: 'her' | 'him' | 'unisex';
  variant: {
    attributes: Record<string, string>;
    attributesLabel: string;
    sku?: string;
    pricePaise: number;
    stock: number;
  };
};

export type PlanEntry = {
  row: number;
  identifier: string;
  action: 'stock_update' | 'variant_create' | 'listing_create' | 'no_change' | 'error';
  stockUpdate?: StockUpdatePlan;
  variantCreate?: VariantCreatePlan;
  listingCreate?: ListingCreatePlan;
  error?: { reason: string; detail?: string };
};

export type ClassifierResult = {
  plan: PlanEntry[];
  summary: {
    parsed: number;
    stockUpdates: number;
    variantCreates: number;
    listingCreates: number;
    noChange: number;
    errors: number;
  };
};

// ───── helpers ─────────────────────────────────────────────────────────

/**
 * Canonical attribute-set string. Same algorithm as the listing variant API's
 * `attributesKey` — keys sorted, joined with `|`. Used as a dedupe key across
 * variants on the same listing.
 */
export function attributesKey(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k.trim()}=${v.trim()}`)
    .join('|');
}

/**
 * Parse the CSV's pipe-encoded `attributes` cell into a Record. Rejects empty
 * keys, duplicate keys, and stray `=` / `|` characters inside values.
 */
export function decodeAttributes(cell: string): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
  const out: Record<string, string> = {};
  const segments = cell.split('|').map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return { ok: false, error: 'empty' };
  for (const seg of segments) {
    const eq = seg.indexOf('=');
    if (eq <= 0 || eq === seg.length - 1) return { ok: false, error: `bad pair "${seg}"` };
    const k = seg.slice(0, eq).trim();
    const v = seg.slice(eq + 1).trim();
    if (!k || !v) return { ok: false, error: `bad pair "${seg}"` };
    if (k.includes('=') || v.includes('=')) return { ok: false, error: `nested = in "${seg}"` };
    if (k in out) return { ok: false, error: `duplicate key "${k}"` };
    out[k] = v;
  }
  return { ok: true, value: out };
}

/** Derive a `M / Black`-style label from the attribute map when the CSV row
 *  doesn't supply one. Values only, joined by ' / ' in the same order as
 *  attributesKey (sorted). Falls back to attributesKey form when empty. */
export function deriveAttributesLabel(attrs: Record<string, string>): string {
  const sorted = Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b));
  const label = sorted.map(([, v]) => v).join(' / ');
  return label || attributesKey(attrs);
}

function resolveBrand(input: string, brands: BrandRecord[]): BrandRecord | null | 'ambiguous' {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // ID match takes priority (admin pasted an id).
  const byId = brands.find((b) => b.id === trimmed);
  if (byId) return byId;
  const slug = trimmed.toLowerCase();
  const bySlug = brands.find((b) => b.slug.toLowerCase() === slug);
  if (bySlug) return bySlug;
  const byName = brands.filter((b) => b.name.toLowerCase() === slug);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) return 'ambiguous';
  return null;
}

function resolveCategory(
  input: string,
  categories: CategoryRecord[],
): CategoryRecord | null | 'ambiguous' {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const byId = categories.find((c) => c.id === trimmed);
  if (byId) return byId;
  const slug = trimmed.toLowerCase();
  const bySlug = categories.find((c) => c.slug.toLowerCase() === slug);
  if (bySlug) return bySlug;
  const byLabel = categories.filter((c) => c.label.toLowerCase() === slug);
  if (byLabel.length === 1) return byLabel[0]!;
  if (byLabel.length > 1) return 'ambiguous';
  return null;
}

// ───── main classifier ─────────────────────────────────────────────────

export function classify(rows: RawImportRow[], ctx: ClassifierContext): ClassifierResult {
  const plan: PlanEntry[] = [];
  const summary = { parsed: rows.length, stockUpdates: 0, variantCreates: 0, listingCreates: 0, noChange: 0, errors: 0 };

  // Build lookups once.
  const bySku = new Map<string, VariantRecord[]>();
  for (const v of ctx.variants) {
    if (!v.sku) continue;
    const arr = bySku.get(v.sku) ?? [];
    arr.push(v);
    bySku.set(v.sku, arr);
  }
  const byNameLabel = new Map<string, VariantRecord[]>();
  const listingNameById = new Map<string, string>();
  for (const l of ctx.listings) listingNameById.set(l.id, l.name);
  for (const v of ctx.variants) {
    const listingName = listingNameById.get(v.listingId);
    if (!listingName) continue;
    const key = `${listingName.trim().toLowerCase()}${v.attributesLabel.trim().toLowerCase()}`;
    const arr = byNameLabel.get(key) ?? [];
    arr.push(v);
    byNameLabel.set(key, arr);
  }
  const byListingNameLower = new Map<string, ListingRecord[]>();
  for (const l of ctx.listings) {
    const key = l.name.trim().toLowerCase();
    const arr = byListingNameLower.get(key) ?? [];
    arr.push(l);
    byListingNameLower.set(key, arr);
  }
  const byListingIdAttrKey = new Map<string, VariantRecord>();
  for (const v of ctx.variants) {
    byListingIdAttrKey.set(`${v.listingId}${attributesKey(v.attributes)}`, v);
  }

  // Within-batch trackers to detect duplicates across rows.
  const batchSkuTargets = new Map<string, number>();          // sku → first row using it
  const batchListingNames = new Map<string, number>();        // lowercased name → first listing_create row
  const batchVariantKeys = new Map<string, number>();         // listingKey + attrKey → first row using it

  rows.forEach((r, idx) => {
    const rowNum = idx + 1;
    const idLabel =
      r.sku ??
      (r.productName && r.variantLabel
        ? `${r.productName} / ${r.variantLabel}`
        : r.productName ?? '(no identifier)');

    function pushError(reason: string, detail?: string) {
      plan.push({ row: rowNum, identifier: idLabel, action: 'error', error: detail ? { reason, detail } : { reason } });
      summary.errors++;
    }

    // 1) SKU path: row carries a SKU. We commit to the SKU lookup; no fallback to name+label.
    if (r.sku) {
      const matches = bySku.get(r.sku) ?? [];
      if (matches.length > 1) return pushError('sku_ambiguous');
      if (matches.length === 1) {
        const v = matches[0]!;
        return planStockUpdate(rowNum, idLabel, r, v);
      }
      // SKU not found. If no productName, we can't classify further.
      if (!r.productName) return pushError('sku_not_found');
      // Else fall through to listing-resolve so we can attach to / create a listing.
    }

    // 2) Need a listing to proceed.
    if (!r.productName) {
      return pushError('variant_not_found', 'No SKU or product_name supplied');
    }
    const listings = byListingNameLower.get(r.productName.trim().toLowerCase()) ?? [];
    if (listings.length > 1) return pushError('listing_name_ambiguous');

    if (listings.length === 1) {
      const listing = listings[0]!;
      // Variant-level: try attributes first (canonical), else fall back to label match.
      const attrs = parseAttrsOrNull(r);
      if (attrs === 'invalid') return pushError('attributes_invalid');
      let target: VariantRecord | undefined;
      if (attrs) {
        target = byListingIdAttrKey.get(`${listing.id}${attributesKey(attrs)}`);
      } else if (r.variantLabel) {
        const candidates = byNameLabel.get(`${listing.name.trim().toLowerCase()}${r.variantLabel.trim().toLowerCase()}`) ?? [];
        if (candidates.length > 1) return pushError('name_label_ambiguous');
        if (candidates.length === 1) target = candidates[0]!;
      }
      if (target) {
        // SKU conflict: row has SKU but it's different from existing variant's.
        if (r.sku && target.sku && r.sku !== target.sku) return pushError('sku_conflict');
        return planStockUpdate(rowNum, idLabel, r, target);
      }
      // No matching variant → create new variant under this listing.
      if (!attrs) return pushError('attributes_missing', 'Need attributes to create a variant');
      if (r.pricePaise === undefined) return pushError('price_missing');
      if (r.pricePaise <= 0) return pushError('price_invalid');
      const attrK = attributesKey(attrs);
      const batchKey = `${listing.id}${attrK}`;
      const dup = batchVariantKeys.get(batchKey);
      if (dup !== undefined) return pushError('attribute_conflict_in_batch', `Same attribute set as row ${dup}`);
      batchVariantKeys.set(batchKey, rowNum);
      if (r.sku) {
        const skuDup = batchSkuTargets.get(r.sku);
        if (skuDup !== undefined) return pushError('sku_taken_in_batch', `SKU also used by row ${skuDup}`);
        if (bySku.has(r.sku)) return pushError('sku_conflict');
        batchSkuTargets.set(r.sku, rowNum);
      }
      const variantCreate: VariantCreatePlan = {
        listingId: listing.id,
        listingName: listing.name,
        attributes: attrs,
        attributesLabel: r.variantLabel?.trim() || deriveAttributesLabel(attrs),
        pricePaise: r.pricePaise,
        stock: r.stock,
      };
      if (r.sku) variantCreate.sku = r.sku;
      plan.push({ row: rowNum, identifier: idLabel, action: 'variant_create', variantCreate });
      summary.variantCreates++;
      return;
    }

    // 3) No listing matches → listing_create. Requires the full bundle.
    const attrs = parseAttrsOrNull(r);
    if (attrs === 'invalid') return pushError('attributes_invalid');
    const missing: string[] = [];
    if (!attrs) missing.push('attributes');
    if (!r.brand) missing.push('brand');
    if (!r.category) missing.push('category');
    if (!r.gender) missing.push('gender');
    if (r.pricePaise === undefined) missing.push('price_paise');
    if (missing.length > 0) return pushError('missing_create_fields', missing.join(', '));

    const brand = resolveBrand(r.brand!, ctx.brands);
    if (brand === 'ambiguous') return pushError('brand_ambiguous');
    if (!brand) return pushError('brand_not_found', r.brand);
    const category = resolveCategory(r.category!, ctx.categories);
    if (category === 'ambiguous') return pushError('category_ambiguous');
    if (!category) return pushError('category_not_found', r.category);

    if (r.pricePaise! <= 0) return pushError('price_invalid');

    const nameKey = r.productName.trim().toLowerCase();
    const existingListingRow = batchListingNames.get(nameKey);
    if (existingListingRow !== undefined) {
      // Another row in this batch is already creating this listing — attach as variant_create.
      // Build the synthetic listingId placeholder: real id is assigned at apply time;
      // the dashboard preview uses the row reference + name.
      const attrK = attributesKey(attrs!);
      const batchKey = `__pending:${nameKey}${attrK}`;
      const dup = batchVariantKeys.get(batchKey);
      if (dup !== undefined) return pushError('attribute_conflict_in_batch', `Same attribute set as row ${dup}`);
      batchVariantKeys.set(batchKey, rowNum);
      if (r.sku) {
        const skuDup = batchSkuTargets.get(r.sku);
        if (skuDup !== undefined) return pushError('sku_taken_in_batch', `SKU also used by row ${skuDup}`);
        if (bySku.has(r.sku)) return pushError('sku_conflict');
        batchSkuTargets.set(r.sku, rowNum);
      }
      const variantCreate: VariantCreatePlan = {
        listingId: `__pending:${nameKey}`,
        listingName: r.productName.trim(),
        attributes: attrs!,
        attributesLabel: r.variantLabel?.trim() || deriveAttributesLabel(attrs!),
        pricePaise: r.pricePaise!,
        stock: r.stock,
      };
      if (r.sku) variantCreate.sku = r.sku;
      plan.push({ row: rowNum, identifier: idLabel, action: 'variant_create', variantCreate });
      summary.variantCreates++;
      return;
    }

    // First row creating this listing.
    batchListingNames.set(nameKey, rowNum);
    const attrK = attributesKey(attrs!);
    batchVariantKeys.set(`__pending:${nameKey}${attrK}`, rowNum);
    if (r.sku) {
      const skuDup = batchSkuTargets.get(r.sku);
      if (skuDup !== undefined) return pushError('sku_taken_in_batch', `SKU also used by row ${skuDup}`);
      if (bySku.has(r.sku)) return pushError('sku_conflict');
      batchSkuTargets.set(r.sku, rowNum);
    }
    const listingCreate: ListingCreatePlan = {
      listingName: r.productName.trim(),
      brandId: brand.id,
      brandSlug: brand.slug,
      categoryId: category.id,
      categorySlug: category.slug,
      gender: r.gender!,
      variant: {
        attributes: attrs!,
        attributesLabel: r.variantLabel?.trim() || deriveAttributesLabel(attrs!),
        pricePaise: r.pricePaise!,
        stock: r.stock,
      },
    };
    if (r.sku) listingCreate.variant.sku = r.sku;
    plan.push({ row: rowNum, identifier: idLabel, action: 'listing_create', listingCreate });
    summary.listingCreates++;
  });

  function parseAttrsOrNull(r: RawImportRow): Record<string, string> | null | 'invalid' {
    if (!r.attributes) return null;
    const decoded = decodeAttributes(r.attributes);
    if (!decoded.ok) return 'invalid';
    return decoded.value;
  }

  function planStockUpdate(rowNum: number, idLabel: string, r: RawImportRow, v: VariantRecord) {
    if (r.stock < v.reserved) {
      plan.push({ row: rowNum, identifier: idLabel, action: 'error', error: { reason: 'below_reserved', detail: `${v.reserved} reserved` } });
      summary.errors++;
      return;
    }
    const wantsPriceChange = r.pricePaise !== undefined && r.pricePaise !== v.pricePaise && r.pricePaise > 0;
    const stockUpdate: StockUpdatePlan = {
      variantId: v.id,
      sku: v.sku,
      currentStock: v.stock,
      newStock: r.stock,
      delta: r.stock - v.stock,
      currentPricePaise: v.pricePaise,
    };
    if (wantsPriceChange) stockUpdate.newPricePaise = r.pricePaise!;
    const noChange = stockUpdate.delta === 0 && !wantsPriceChange;
    if (noChange) {
      plan.push({ row: rowNum, identifier: idLabel, action: 'no_change', stockUpdate });
      summary.noChange++;
    } else {
      plan.push({ row: rowNum, identifier: idLabel, action: 'stock_update', stockUpdate });
      summary.stockUpdates++;
    }
  }

  return { plan, summary };
}
