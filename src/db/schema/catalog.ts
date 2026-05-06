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
      Record<string, { type: 'enum' | 'free_text'; required: boolean; values?: string[] }>
    >()
    .notNull(),
  isPlatformDefault: boolean('is_platform_default').notNull().default(false),
});

export const aiCatalogSubmissions = pgTable('ai_catalog_submissions', {
  id: text('id').primaryKey(),
  storeId: text('store_id')
    .notNull()
    .references(() => retailerStores.id),
  listingId: text('listing_id').references(() => productListings.id), // nullable: review-first then attach
  mode: aiCatalogMode('mode').notNull(),
  rawPhotos: jsonb('raw_photos').$type<string[]>().notNull(),
  outputUrls: jsonb('output_urls').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  status: aiCatalogStatus('status').notNull().default('submitted'),
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
