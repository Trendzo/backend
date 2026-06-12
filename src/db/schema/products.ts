import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { brands } from './brands.js';
import { categories } from './categories.js';
import { attributeTemplates } from './catalog.js';
import { gender, listingPolicy, listingStatus, variantMode } from './enums.js';
import { retailerStores } from './store.js';

/**
 * Product model: a `product_listing` is one product as sold by one store. There is no
 * "canonical product" shared across retailers — two stores selling the same Nike t-shirt
 * have two independent listings. Variants carry the actual stock count and price.
 *
 * `brandId` and `categoryId` FK into the structured brand/category lookups (the consumer
 * app needs entity-shaped brand + category data — see `frontend/src/data/mockData.ts`).
 *
 * `ratingAvg` + `ratingCount` are denormalised projection columns kept in sync by the
 * future reviews module. They live here so the consumer card render is single-row.
 */
export const productListings = pgTable(
  'product_listings',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id')
      .notNull()
      .references(() => retailerStores.id),
    templateId: text('template_id').references(() => attributeTemplates.id),
    // Nullable + ON DELETE SET NULL: deleting a brand must not break listings.
    // Existing products keep their commerce flow (price, stock, gallery, orders);
    // they just render as "Unbranded" until the retailer assigns a new brand.
    brandId: text('brand_id').references(() => brands.id, { onDelete: 'set null' }),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id),
    name: text('name').notNull(),
    description: text('description'),
    // Rich-text long description: sanitized HTML (see shared/sanitize/rich-text.ts).
    // Sanitize-on-write — anything stored here is safe to render verbatim.
    descriptionLong: text('description_long'),
    hsn: text('hsn'), // GST HSN code
    gender: gender('gender').notNull(),
    listingPolicy: listingPolicy('listing_policy').notNull().default('return'),
    galleryUrls: jsonb('gallery_urls').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    occasion: jsonb('occasion').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    // Numeric age ranges this product targets (multi-select; [] = unspecified).
    // Values come from the AGE_RANGES list in listings.validators.ts.
    ageGroups: jsonb('age_groups').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    status: listingStatus('status').notNull().default('draft'),
    // How variants are structured (see variant_mode enum). 'custom' ⇔ templateId set.
    variantMode: variantMode('variant_mode').notNull().default('single'),
    // US-5.7.2: when admin takes a listing down, the previous status is saved here
    // so US-5.7.3 restore can revert to the right state (active vs draft).
    statusBeforeTakedown: listingStatus('status_before_takedown'),

    // Reviews projection — updated by the (future) reviews module; kept here so the
    // consumer card render is a single-row read.
    ratingAvg: numeric('rating_avg', { precision: 3, scale: 2 }).notNull().default('0'),
    ratingCount: integer('rating_count').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    storeStatusIdx: index('product_listings_store_status_idx').on(t.storeId, t.status),
    categoryIdx: index('product_listings_category_idx').on(t.categoryId),
    brandIdx: index('product_listings_brand_idx').on(t.brandId),
    genderStatusIdx: index('product_listings_gender_status_idx').on(t.gender, t.status),
    ratingGuard: check(
      'product_listings_rating_guard',
      sql`${t.ratingAvg} >= 0 AND ${t.ratingAvg} <= 5 AND ${t.ratingCount} >= 0`,
    ),
  }),
);

/**
 * Variant group = the system-defined parent level of the variant hierarchy. For the
 * color→size flow each group is one color ("Red"); its child variants are the sizes.
 * Every listing owns exactly one `is_default` group (created with the listing): the
 * single-product default variant and all custom-template variants live there.
 * Invariant: every variant belongs to exactly one group.
 */
export const variantGroups = pgTable(
  'variant_groups',
  {
    id: text('id').primaryKey(),
    listingId: text('listing_id')
      .notNull()
      .references(() => productListings.id),
    // Denormalized like variants.storeId so store-scoped reads skip the listing join.
    storeId: text('store_id')
      .notNull()
      .references(() => retailerStores.id),
    name: text('name').notNull(), // "Red"; "Default" for the default group
    // Optional swatch hex (#RRGGBB). The name stays free-form ("Midnight Green",
    // brand-specific color naming); the hex drives swatch UI.
    colorHex: text('color_hex'),
    sortOrder: integer('sort_order').notNull().default(0),
    isDefault: boolean('is_default').notNull().default(false),
    // Group-level kill switch: a variant is shoppable only when both it and its
    // group are active ("hide Red entirely" in one toggle).
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    listingIdx: index('variant_groups_listing_idx').on(t.listingId),
    // No duplicate "Red"/"red" within one listing.
    namePerListingIdx: uniqueIndex('variant_groups_listing_name_idx').on(
      t.listingId,
      sql`lower(${t.name})`,
    ),
    // At most one default group per listing.
    defaultPerListingIdx: uniqueIndex('variant_groups_listing_default_idx')
      .on(t.listingId)
      .where(sql`${t.isDefault}`),
  }),
);

/**
 * Variant = one (listing, attribute combination). The stock count and price live here.
 * Per the ERD note: `available` is computed (stock − reserved), not stored.
 */
export const variants = pgTable(
  'variants',
  {
    id: text('id').primaryKey(),
    listingId: text('listing_id')
      .notNull()
      .references(() => productListings.id),
    // Denormalized from the parent listing so SKUs can be enforced unique
    // store-wide (variants only carry listingId otherwise). Kept in sync on
    // every create/bulk insert.
    storeId: text('store_id')
      .notNull()
      .references(() => retailerStores.id),
    // Parent group (color for the system flow; the listing's default group otherwise).
    groupId: text('group_id')
      .notNull()
      .references(() => variantGroups.id),
    sku: text('sku'), // retailer's own SKU code; nullable, auto-generated when omitted
    // Scannable barcode (EAN/UPC/Code128) printed on the physical tag. Distinct from `sku`
    // (the internal code) — the POS scanner matches this first, then falls back to sku.
    barcode: text('barcode'),
    attributes: jsonb('attributes').$type<Record<string, string>>().notNull(),
    attributesLabel: text('attributes_label').notNull(), // e.g. "M / Black"
    // Per-variant gallery — Shopify-style. First URL is the variant's primary image
    // (used in product cards). Listing.galleryUrls remains for listing-level shots.
    imageUrls: jsonb('image_urls').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    isActive: boolean('is_active').notNull().default(true),
    stock: integer('stock').notNull().default(0),
    reserved: integer('reserved').notNull().default(0),
    pricePaise: integer('price_paise').notNull(),
    // Struck-through "was" price (paise). Nullable; when set must exceed pricePaise.
    compareAtPrice: integer('compare_at_price'),
    // US-5.6.4: set true when a template edit removes an axis or enum value that
    // this variant was using. Retailer sees these flagged for review on the listing
    // detail; backend never auto-deletes a variant.
    attributesOutOfTemplate: boolean('attributes_out_of_template').notNull().default(false),
  },
  (t) => ({
    listingIdx: index('variants_listing_idx').on(t.listingId),
    storeIdx: index('variants_store_idx').on(t.storeId),
    groupIdx: index('variants_group_idx').on(t.groupId),
    // SKU unique per store when present — store-wide so a retailer never has two
    // SKUs colliding across their products. Auto-gen guarantees uniqueness.
    skuPerStoreIdx: uniqueIndex('variants_store_sku_idx')
      .on(t.storeId, t.sku)
      .where(sql`${t.sku} IS NOT NULL`),
    // Barcode unique per store when present — mirrors the SKU rule. A physical tag
    // scans to exactly one variant within a store.
    barcodePerStoreIdx: uniqueIndex('variants_store_barcode_idx')
      .on(t.storeId, t.barcode)
      .where(sql`${t.barcode} IS NOT NULL`),
    stockGuard: check(
      'variants_stock_guard',
      sql`${t.stock} >= 0 AND ${t.reserved} >= 0 AND ${t.reserved} <= ${t.stock} AND ${t.pricePaise} > 0`,
    ),
  }),
);

// ===== Relations =====

export const productListingsRelations = relations(productListings, ({ many, one }) => ({
  store: one(retailerStores, {
    fields: [productListings.storeId],
    references: [retailerStores.id],
  }),
  template: one(attributeTemplates, {
    fields: [productListings.templateId],
    references: [attributeTemplates.id],
  }),
  brand: one(brands, {
    fields: [productListings.brandId],
    references: [brands.id],
  }),
  category: one(categories, {
    fields: [productListings.categoryId],
    references: [categories.id],
  }),
  variants: many(variants),
  variantGroups: many(variantGroups),
}));

export const variantGroupsRelations = relations(variantGroups, ({ many, one }) => ({
  listing: one(productListings, {
    fields: [variantGroups.listingId],
    references: [productListings.id],
  }),
  variants: many(variants),
}));

export const variantsRelations = relations(variants, ({ one }) => ({
  listing: one(productListings, {
    fields: [variants.listingId],
    references: [productListings.id],
  }),
  group: one(variantGroups, {
    fields: [variants.groupId],
    references: [variantGroups.id],
  }),
}));
