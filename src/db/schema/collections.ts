import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { collectionKind, collectionStatus, gender } from './enums.js';
import { productListings } from './products.js';

/**
 * Curated grouping of product listings — covers the consumer app's "GET THE LOOK"
 * outfit bundles, "OCCASION" scrolls, drops, edits, and trend reels. One row per group;
 * `kind` discriminates outfit vs occasion vs drop vs edit vs trend.
 *
 * Naming note: PRODUCT_SPEC's word "bundle" refers to a *promotion discount mechanic*
 * (line 656). The frontend's "bundle" is a curatorial concept — modeled here as
 * `collections.kind = 'outfit'`. The two never overlap.
 *
 * Per-gender via `gender` enum (the consumer app keeps HER and HIM collections strictly
 * separate). startsAt/endsAt are nullable — only drops/trends are time-bound; outfits and
 * occasions are evergreen.
 */
export const collections = pgTable(
  'collections',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    kind: collectionKind('kind').notNull(),
    gender: gender('gender').notNull().default('unisex'),
    description: text('description'),
    heroImageUrl: text('hero_image_url'),
    accentColors: jsonb('accent_colors').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    sortOrder: integer('sort_order').notNull().default(0),
    isFeatured: boolean('is_featured').notNull().default(false),
    status: collectionStatus('status').notNull().default('draft'),
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }),
    endsAt: timestamp('ends_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    slugIdx: uniqueIndex('collections_slug_idx').on(t.slug),
    kindGenderStatusIdx: index('collections_kind_gender_status_idx').on(t.kind, t.gender, t.status),
  }),
);

/**
 * Many-to-many between collections and product_listings. Composite PK prevents duplicate
 * memberships; sortOrder lets curators control the in-collection ordering shown to consumers.
 */
export const collectionListings = pgTable(
  'collection_listings',
  {
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    listingId: text('listing_id')
      .notNull()
      .references(() => productListings.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
    addedAt: timestamp('added_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.collectionId, t.listingId] }),
    listingIdx: index('collection_listings_listing_idx').on(t.listingId),
  }),
);

// ===== Relations =====

export const collectionsRelations = relations(collections, ({ many }) => ({
  listings: many(collectionListings),
}));

export const collectionListingsRelations = relations(collectionListings, ({ one }) => ({
  collection: one(collections, {
    fields: [collectionListings.collectionId],
    references: [collections.id],
  }),
  listing: one(productListings, {
    fields: [collectionListings.listingId],
    references: [productListings.id],
  }),
}));
