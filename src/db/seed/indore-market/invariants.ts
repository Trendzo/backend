/**
 * Every cross-field rule the composed catalog must satisfy, in one place.
 *
 * Run by the dry-run (offline, before anything is written) and again inside the
 * transaction before COMMIT. A violation is a bug in the vocabulary or the
 * distribution, and it should surface as a failed assertion on a laptop — never as a
 * wrong-looking product in a live marketplace.
 */

import { BRAND_GENDER, LEAF_SPECS } from './leaf-catalog.js';
import { countForLeaf, STORE_COUNT, TOTAL_PRODUCTS } from './distribute.js';
import { STORES } from './stores.js';
import type { Composed, ComposedListing } from './compose.js';
import type { ImagePool } from './fetch-images.js';

export function checkInvariants(composed: Composed, pool: ImagePool): string[] {
  const problems: string[] = [];
  const fail = (msg: string) => problems.push(msg);
  const { listings } = composed;

  // --- shape ---------------------------------------------------------------
  if (listings.length !== TOTAL_PRODUCTS) fail(`Expected ${TOTAL_PRODUCTS} listings, composed ${listings.length}`);

  const perStore = new Map<number, ComposedListing[]>();
  const perLeaf = new Map<string, ComposedListing[]>();
  for (const l of listings) {
    (perStore.get(l.storeIndex) ?? perStore.set(l.storeIndex, []).get(l.storeIndex)!).push(l);
    (perLeaf.get(l.leafSlug) ?? perLeaf.set(l.leafSlug, []).get(l.leafSlug)!).push(l);
  }

  if (perStore.size !== STORE_COUNT) fail(`Expected ${STORE_COUNT} stores used, got ${perStore.size}`);
  for (const [idx, rows] of perStore) {
    const name = STORES[idx]?.legalName ?? `#${idx}`;
    if (rows.length !== TOTAL_PRODUCTS / STORE_COUNT) {
      fail(`Store ${name} has ${rows.length} listings, expected ${TOTAL_PRODUCTS / STORE_COUNT}`);
    }
    // A store holding two products from one leaf would give it duplicate-ish shelves.
    const leaves = new Set(rows.map((r) => r.leafSlug));
    if (leaves.size !== rows.length) fail(`Store ${name} has two listings on the same leaf`);
    const names = new Set(rows.map((r) => r.name.toLowerCase()));
    if (names.size !== rows.length) fail(`Store ${name} has duplicate product names`);
  }

  if (perLeaf.size !== LEAF_SPECS.length) {
    fail(`Only ${perLeaf.size}/${LEAF_SPECS.length} leaves covered`);
  }
  LEAF_SPECS.forEach((spec, i) => {
    const got = perLeaf.get(spec.slug)?.length ?? 0;
    const want = countForLeaf(i);
    if (got !== want) fail(`Leaf ${spec.slug} has ${got} listings, expected ${want}`);
    if (!pool[spec.slug]?.length) fail(`Leaf ${spec.slug} has no photos in image-pool.json`);
  });

  // --- per listing ---------------------------------------------------------
  const allIds = new Set<string>();
  const skusByStore = new Map<number, Set<string>>();

  for (const l of listings) {
    const where = `${l.id} (${l.name})`;
    if (allIds.has(l.id)) fail(`Duplicate listing id ${l.id}`);
    allIds.add(l.id);

    // The exact conditions assertListingPublishable enforces server-side.
    if (!l.name.trim()) fail(`${where}: empty name`);
    if (!l.description.trim()) fail(`${where}: empty short description`);
    if (!l.descriptionLong.trim()) fail(`${where}: empty full description`);
    if (l.galleryUrls.length < 1) fail(`${where}: empty gallery`);

    const spec = LEAF_SPECS.find((s) => s.slug === l.leafSlug);
    if (!spec) {
      fail(`${where}: unknown leaf ${l.leafSlug}`);
      continue;
    }
    // Gender must match the leaf, or the product is invisible on its own rail.
    if (l.gender !== spec.gender) fail(`${where}: gender ${l.gender} but leaf is ${spec.gender}`);
    // Brand must come from this leaf's affinity list — the anti-Gucci-sherwani rule.
    if (!spec.brands.includes(l.brandSlug)) fail(`${where}: brand ${l.brandSlug} not valid for ${l.leafSlug}`);
    // …and a single-rail brand must not appear on the other rail's leaf.
    const brandGender = BRAND_GENDER[l.brandSlug];
    if (brandGender && l.gender !== 'unisex' && brandGender !== l.gender) {
      fail(`${where}: ${l.brandSlug} is a ${brandGender} brand on a ${l.gender} leaf`);
    }
    if (brandGender && l.gender === 'unisex') {
      fail(`${where}: ${l.brandSlug} is ${brandGender}-only but the leaf is unisex`);
    }
    // Name must actually name the thing being sold.
    if (!l.name.endsWith(spec.noun)) fail(`${where}: name does not end in the leaf noun "${spec.noun}"`);

    // Photos must come from THIS leaf's pool, never a parent fallback.
    const poolIds = new Set((pool[l.leafSlug] ?? []).map((p) => p.raw));
    for (const url of l.galleryUrls) {
      const raw = url.split('?')[0]!;
      if (![...poolIds].some((r) => r.startsWith(raw))) {
        fail(`${where}: gallery image not from the ${l.leafSlug} pool`);
        break;
      }
    }

    // --- groups ---
    const defaults = l.groups.filter((g) => g.isDefault);
    if (defaults.length !== 1) fail(`${where}: ${defaults.length} default groups, expected exactly 1`);
    const gNames = new Set(l.groups.map((g) => g.name.toLowerCase()));
    if (gNames.size !== l.groups.length) fail(`${where}: variant group names collide case-insensitively`);

    // --- variants ---
    if (!l.variants.length) fail(`${where}: no variants`);
    const groupIds = new Set(l.groups.map((g) => g.id));
    const storeSkus = skusByStore.get(l.storeIndex) ?? new Set<string>();
    skusByStore.set(l.storeIndex, storeSkus);

    for (const v of l.variants) {
      if (allIds.has(v.id)) fail(`Duplicate variant id ${v.id}`);
      allIds.add(v.id);
      if (!v.sku.trim()) fail(`${where}: variant ${v.attributesLabel} has no SKU`);
      if (v.sku.length > 64) fail(`${where}: SKU ${v.sku} exceeds 64 chars`);
      if (storeSkus.has(v.sku)) fail(`Duplicate SKU ${v.sku} within store ${l.storeIndex}`);
      storeSkus.add(v.sku);
      // variants_stock_guard
      if (!(v.pricePaise > 0)) fail(`${where}: variant ${v.attributesLabel} price must be > 0`);
      if (v.stock < 0) fail(`${where}: negative stock`);
      if (v.compareAtPrice !== null && v.compareAtPrice <= v.pricePaise) {
        fail(`${where}: compareAtPrice must exceed price`);
      }
      if (!groupIds.has(v.groupId)) fail(`${where}: variant points at a group not on this listing`);
      // A default-group variant would be unreachable from the colour picker.
      if (v.groupId === defaults[0]?.id) fail(`${where}: variant sits in the Default group`);
    }
  }

  return problems;
}

/** Rough shape of the run, for the dry-run manifest and the console summary. */
export function summarise(composed: Composed): Record<string, number> {
  const variants = composed.listings.reduce((n, l) => n + l.variants.length, 0);
  const groups = composed.listings.reduce((n, l) => n + l.groups.length, 0);
  return {
    stores: STORES.length,
    retailerAccounts: STORES.length,
    bankAccounts: STORES.length,
    termsAcceptances: STORES.length * 2,
    listings: composed.listings.length,
    variantGroups: groups,
    variants,
  };
}
