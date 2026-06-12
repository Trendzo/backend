import { relations, sql } from 'drizzle-orm';
import { boolean, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { aiCatalogMode, aiCatalogStatus } from './enums.js';
import { productListings } from './products.js';
import { retailerStores } from './store.js';

/**
 * Catalog metadata + tooling — everything that supports the product catalog without
 * being the products themselves. Two concerns:
 *   1. attribute_templates: defines the shape of products in a category (what axes they
 *      have, e.g. Apparel = size + colour, Footwear = size + colour). Platform-default
 *      templates have null owner_store_id; retailers may also define their own.
 *   2. ai_catalog_submissions: a third-party-AI flow that turns phone snapshots into
 *      polished listing-ready images, optionally with a virtual model.
 *
 * The actual sellable model (productListings + variants) lives in `products.ts`.
 */

export const attributeTemplates = pgTable('attribute_templates', {
  id: text('id').primaryKey(),
  ownerStoreId: text('owner_store_id').references(() => retailerStores.id), // null for platform templates
  name: text('name').notNull(),
  axes: jsonb('axes')
    .$type<
      Record<
        string,
        { type: 'enum' | 'free_text' | 'numeric' | 'color'; required: boolean; values?: string[] }
      >
    >()
    .notNull(),
  isPlatformDefault: boolean('is_platform_default').notNull().default(false),
  // Usage tracking for "suggest my recent / popular templates" sorting.
  // usageCount = number of times attached to a listing; lastUsedAt = most
  // recent attach or variant-create under a listing carrying this template.
  usageCount: integer('usage_count').notNull().default(0),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
});

/**
 * Platform size scales for the system color → size variant flow. Each row is
 * one sizing system ("UK", "EU", "Letter", "Waist (in)", …) with its pick-list
 * values. `categorySlugs` names the category slugs the scale applies to —
 * empty array = universal (offered for every category). The wizard resolves
 * a listing's category (walking up the parent chain) against these to decide
 * which size systems to offer; free-typed sizes are always accepted on top.
 */
export const sizeScales = pgTable('size_scales', {
  id: text('id').primaryKey(),
  name: text('name').notNull(), // e.g. "UK", "Letter sizes", "Waist (in)"
  values: jsonb('values').$type<string[]>().notNull(),
  categorySlugs: jsonb('category_slugs').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
});

export const aiCatalogSubmissions = pgTable('ai_catalog_submissions', {
  id: text('id').primaryKey(),
  storeId: text('store_id')
    .notNull()
    .references(() => retailerStores.id),
  // Nullable at the column level for back-compat with rows seeded before
  // Module 7 went live; new submissions require it (enforced at the route).
  listingId: text('listing_id').references(() => productListings.id),
  // Optional variant the retailer wants the output attached to. When set, the
  // accepted output URL is appended to `variants.image_urls`; otherwise it goes
  // to `product_listings.gallery_urls`.
  targetVariantId: text('target_variant_id'),
  mode: aiCatalogMode('mode').notNull(),
  // Retailer's freeform instruction for the AI provider (8-800 chars at route).
  prompt: text('prompt').notNull().default(''),
  // Subset of rawPhotos actually shipped to Gemini as multimodal context.
  referenceImageUrls: jsonb('reference_image_urls')
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  // Populated on regenerate children with the retailer's revision instructions.
  revisionNotes: text('revision_notes'),
  rawPhotos: jsonb('raw_photos').$type<string[]>().notNull(),
  outputUrls: jsonb('output_urls').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  status: aiCatalogStatus('status').notNull().default('submitted'),
  // Populated when `status = 'failed'` so retailer sees the provider error.
  errorMessage: text('error_message'),
  costPaise: integer('cost_paise'),
  parentSubmissionId: text('parent_submission_id'),
  thirdPartyRequestId: text('third_party_request_id'),
  at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

// ===== Relations =====

export const attributeTemplatesRelations = relations(attributeTemplates, ({ one }) => ({
  ownerStore: one(retailerStores, {
    fields: [attributeTemplates.ownerStoreId],
    references: [retailerStores.id],
  }),
}));

export const aiCatalogSubmissionsRelations = relations(aiCatalogSubmissions, ({ one }) => ({
  store: one(retailerStores, {
    fields: [aiCatalogSubmissions.storeId],
    references: [retailerStores.id],
  }),
  listing: one(productListings, {
    fields: [aiCatalogSubmissions.listingId],
    references: [productListings.id],
  }),
}));
