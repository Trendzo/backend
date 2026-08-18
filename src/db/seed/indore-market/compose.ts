/**
 * Pure composition: slots + leaf specs + image pool → the exact rows to insert.
 *
 * Everything here is deterministic given (imagePool, now). No DB, no randomness. The
 * seed calls this, asserts the invariants, and only then opens a transaction — so the
 * interesting part (is this catalog coherent?) is decided entirely offline.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { categoryDefaultHsn } from '@/shared/pos/gst-rates.js';
import type { Gender } from '@/shared/catalog/taxonomy.js';
import {
  BRAND_NAMES,
  LEAF_SPECS,
  SIZE_RUNS,
  productColors,
  productName,
  productPrice,
  type Colorway,
  type LeafSpec,
} from './leaf-catalog.js';
import { buildSlots, createdAtFor, type Slot } from './distribute.js';
import { STORES, OPENING_HOURS, type StoreSeed } from './stores.js';
import type { ImagePool, PoolPhoto } from './fetch-images.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const POOL_PATH = resolve(HERE, 'image-pool.json');

/** How many gallery photos each listing carries. */
const GALLERY_SIZE = 3;
/** Photos are hotlinked from Unsplash at this width, matching fix-images.ts. */
const IMG_WIDTH = 900;

export function loadImagePool(): ImagePool {
  if (!existsSync(POOL_PATH)) {
    throw new Error(`image-pool.json not found. Run fetch-images.ts first.`);
  }
  return JSON.parse(readFileSync(POOL_PATH, 'utf8')) as ImagePool;
}

/**
 * HSN for a leaf, working around a bug in the shared resolver.
 *
 * `categoryDefaultHsn` falls back through `parentOf` (gst-rates.ts:46), which strips
 * only ONE trailing slug segment. So `coords-two-piece` becomes `coords-two`,
 * misses `HSN_BY_PARENT`, and lands on the generic `6109` instead of Co-ords' `6204`;
 * `bottoms-wide-leg` likewise loses `6203`. We know the real parent, so when the leaf
 * lookup produces the generic default and the parent has something specific, prefer the
 * parent's. Fixing `parentOf` itself would change GST classification for listings that
 * already exist, which is not this seed's call to make.
 */
function hsnFor(leafSlug: string, parentSlug: string): string | null {
  const leafHsn = categoryDefaultHsn(leafSlug);
  const parentHsn = categoryDefaultHsn(parentSlug);
  return leafHsn === '6109' && parentHsn !== '6109' ? parentHsn : leafHsn;
}

const photoUrl = (p: PoolPhoto): string =>
  `${p.raw}${p.raw.includes('?') ? '&' : '?'}w=${IMG_WIDTH}&q=80&auto=format&fit=crop`;

// ---------------------------------------------------------------------------
// Ids. Zero-padded fixed width so `store.id.slice(-6)` (billing statement numbers,
// shared/settlement/statement.ts) and `.slice(-8)` (storage object keys) stay distinct
// across the 20 stores. Prefixes match shared/ids.ts so the ids stay greppable.
// ---------------------------------------------------------------------------
const MARKER = 's2';
export const storeId = (n: string) => `str_${MARKER}_${n}`;
export const accountId = (n: string) => `ret_${MARKER}_${n}`;
export const bankId = (n: string) => `bnk_${MARKER}_${n}`;
export const acceptanceId = (n: string, kind: string) => `term_${MARKER}_${n}_${kind}`;
const leafKey = (leafIndex: number) => String(leafIndex).padStart(3, '0');
export const listingId = (leafIndex: number, k: number) => `lst_${MARKER}_${leafKey(leafIndex)}_${k}`;
const groupId = (leafIndex: number, k: number, g: string) => `vgrp_${MARKER}_${leafKey(leafIndex)}_${k}_${g}`;
const variantId = (leafIndex: number, k: number, ci: number, si: number) =>
  `var_${MARKER}_${leafKey(leafIndex)}_${k}_${ci}_${si}`;

/**
 * Deterministic, provably store-unique SKU.
 *
 * NOT `shared/sku.ts` generateSku: that uses Math.random() and an async per-SKU
 * existence check, which for ~4,000 variants means ~4,000 sequential round-trips inside
 * the transaction, and a different result every run. Here uniqueness under
 * `variants_store_sku_idx (store_id, sku)` is true by construction — (leafIndex, k, ci,
 * si) is unique within a store, since a store never holds two products from one leaf.
 */
const skuFor = (s: StoreSeed, slot: Slot, noun: string, ci: number, si: number): string => {
  const nounCode = noun.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 8);
  return `S2-${s.n}-${leafKey(slot.leafIndex)}-${nounCode}-${slot.k}${ci}${si}`;
};

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------
const article = (w: string) => (/^[AEIOU]/i.test(w) ? 'an' : 'a');

function shortDescription(spec: LeafSpec, name: string, colors: Colorway[]): string {
  const shades = colors.map((c) => c.name.toLowerCase()).join(' and ');
  return `${name} from our ${spec.noun.toLowerCase()} range, available in ${shades}.`;
}

function longDescription(
  spec: LeafSpec,
  name: string,
  colors: Colorway[],
  sizes: string[],
  brandName: string,
): string {
  const material = spec.materials.length ? spec.materials[0]! : null;
  const madeOf = material ? ` cut in ${material.toLowerCase()}` : '';
  const sizeLine =
    sizes.length === 1 && sizes[0] === 'Free Size'
      ? 'One size, designed to suit most.'
      : `Available in ${sizes.join(', ')}.`;
  const care = material
    ? 'Machine wash cold with like colours. Do not bleach. Warm iron if needed.'
    : 'Store in a cool, dry place away from direct sunlight.';

  return [
    `<p>${article(name)} ${name.toLowerCase()}${madeOf} by ${brandName}, made for ${spec.occasion.join(' and ')} wear.</p>`,
    `<p>${sizeLine} Offered in ${colors.map((c) => c.name).join(' and ')}.</p>`,
    '<ul>',
    `<li>Category: ${spec.noun}</li>`,
    material ? `<li>Material: ${material}</li>` : '',
    `<li>Care: ${care}</li>`,
    '</ul>',
  ]
    .filter(Boolean)
    .join('');
}

// ---------------------------------------------------------------------------
// Composed shapes
// ---------------------------------------------------------------------------
export type ComposedVariant = {
  id: string;
  listingId: string;
  groupId: string;
  sku: string;
  size: string;
  colorName: string;
  attributesLabel: string;
  pricePaise: number;
  compareAtPrice: number | null;
  stock: number;
};

export type ComposedGroup = {
  id: string;
  listingId: string;
  name: string;
  colorHex: string | null;
  sortOrder: number;
  isDefault: boolean;
};

export type ComposedListing = {
  id: string;
  storeIndex: number;
  storeId: string;
  leafSlug: string;
  categorySlug: string;
  name: string;
  gender: Gender;
  brandSlug: string;
  brandName: string;
  description: string;
  descriptionLong: string;
  /** null when the taxonomy has no default HSN for this leaf — the column is nullable
   *  and GST falls back to the platform rate, so inventing a code would be worse. */
  hsn: string | null;
  galleryUrls: string[];
  createdAt: Date;
  groups: ComposedGroup[];
  variants: ComposedVariant[];
};

export type Composed = {
  listings: ComposedListing[];
  slots: Slot[];
};

/** Real brand name. Throws rather than guessing — this string ships in product copy. */
const brandLabel = (slug: string): string => {
  const name = BRAND_NAMES[slug];
  if (!name) throw new Error(`No display name for brand "${slug}" — add it to BRAND_NAMES`);
  return name;
};

export function compose(pool: ImagePool, now: Date): Composed {
  const slots = buildSlots();

  const listings = slots.map((slot): ComposedListing => {
    const spec = LEAF_SPECS[slot.leafIndex]!;
    const store = STORES[slot.storeIndex]!;
    const name = productName(spec, slot.k, slot.leafIndex);
    const colors = productColors(spec, slot.k, slot.leafIndex);
    const sizes = SIZE_RUNS[spec.sizeKind];
    const price = productPrice(spec, slot.k, slot.countForLeaf, slot.leafIndex);
    const pricePaise = price * 100;
    // Every third product carries a struck-through "was" price. The DB requires
    // compareAtPrice > pricePaise, so a flat 1.4x is always valid.
    const compareAtPrice = slot.index % 3 === 0 ? Math.round(pricePaise * 1.4) : null;

    // Brand comes from the LEAF's own affinity list, never a global round-robin —
    // that round-robin is exactly what put Gucci on a sherwani. Offset by the leaf so
    // neighbouring categories don't all lead with the same label.
    const brandSlug = spec.brands[(slot.k + slot.leafIndex) % spec.brands.length]!;

    const photos = pool[spec.slug] ?? [];
    const gallery = Array.from({ length: Math.min(GALLERY_SIZE, photos.length) }, (_, i) =>
      photoUrl(photos[(slot.k * GALLERY_SIZE + i) % photos.length]!),
    );

    const lid = listingId(slot.leafIndex, slot.k);

    const groups: ComposedGroup[] = [
      // Every listing owns exactly one isDefault group — the invariant
      // shared/variant-groups.ts maintains and `variant_groups_listing_default_idx`
      // enforces. It stays empty; the stock lives in the colour groups.
      { id: groupId(slot.leafIndex, slot.k, 'd'), listingId: lid, name: 'Default', colorHex: null, sortOrder: 0, isDefault: true },
      ...colors.map((c, ci) => ({
        id: groupId(slot.leafIndex, slot.k, String(ci)),
        listingId: lid,
        name: c.name,
        colorHex: c.hex,
        sortOrder: ci + 1,
        isDefault: false,
      })),
    ];

    const variants: ComposedVariant[] = colors.flatMap((c, ci) =>
      sizes.map((size, si): ComposedVariant => ({
        id: variantId(slot.leafIndex, slot.k, ci, si),
        listingId: lid,
        groupId: groupId(slot.leafIndex, slot.k, String(ci)),
        sku: skuFor(store, slot, spec.noun, ci, si),
        size,
        colorName: c.name,
        attributesLabel: `${size} / ${c.name}`,
        pricePaise,
        compareAtPrice,
        stock: 4 + ((slot.index + ci * 5 + si * 3) % 18),
      })),
    );

    return {
      id: lid,
      storeIndex: slot.storeIndex,
      storeId: storeId(store.n),
      leafSlug: spec.slug,
      categorySlug: spec.slug,
      name,
      gender: spec.gender,
      brandSlug,
      brandName: brandLabel(brandSlug),
      description: shortDescription(spec, name, colors),
      descriptionLong: longDescription(spec, name, colors, sizes, brandLabel(brandSlug)),
      hsn: hsnFor(spec.slug, spec.parentSlug),
      galleryUrls: gallery,
      createdAt: createdAtFor(slot.index, now),
      groups,
      variants,
    };
  });

  return { listings, slots };
}

export { OPENING_HOURS, STORES };
