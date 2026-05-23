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
import { gender, listingBadge, listingPolicy, listingStatus } from './enums.js';
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
    hsn: text('hsn'), // GST HSN code
    gender: gender('gender').notNull(),
    badge: listingBadge('badge').notNull().default('none'),
    listingPolicy: listingPolicy('listing_policy').notNull().default('return'),
    galleryUrls: jsonb('gallery_urls').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    occasion: jsonb('occasion').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    ageGroup: text('age_group'),
    status: listingStatus('status').notNull().default('draft'),
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
    sku: text('sku'), // retailer's own SKU code; nullable for MVP
    attributes: jsonb('attributes').$type<Record<string, string>>().notNull(),
    attributesLabel: text('attributes_label').notNull(), // e.g. "M / Black"
    // Per-variant gallery — Shopify-style. First URL is the variant's primary image
    // (used in product cards). Listing.galleryUrls remains for listing-level shots.
    imageUrls: jsonb('image_urls').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    isActive: boolean('is_active').notNull().default(true),
    stock: integer('stock').notNull().default(0),
    reserved: integer('reserved').notNull().default(0),
    pricePaise: integer('price_paise').notNull(),
    // US-5.6.4: set true when a template edit removes an axis or enum value that
    // this variant was using. Retailer sees these flagged for review on the listing
    // detail; backend never auto-deletes a variant.
    attributesOutOfTemplate: boolean('attributes_out_of_template').notNull().default(false),
  },
  (t) => ({
    listingIdx: index('variants_listing_idx').on(t.listingId),
    // SKU unique per listing when present; retailer is responsible for broader collisions.
    skuPerListingIdx: uniqueIndex('variants_listing_sku_idx')
      .on(t.listingId, t.sku)
      .where(sql`${t.sku} IS NOT NULL`),
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
}));

export const variantsRelations = relations(variants, ({ one }) => ({
  listing: one(productListings, {
    fields: [variants.listingId],
    references: [productListings.id],
  }),
}));
