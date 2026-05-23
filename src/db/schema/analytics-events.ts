/**
 * §21 Analytics — lightweight event stream for impression → cart → delivered funnel.
 * Optimised for write throughput + per-listing rollup queries. No indexes on consumerId
 * (privacy + low query value).
 */
import { relations, sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { consumers } from './identity.js';
import { productListings, variants } from './products.js';
import { retailerStores } from './store.js';

export const listingViews = pgTable(
  'listing_views',
  {
    id: text('id').primaryKey(),
    listingId: text('listing_id')
      .notNull()
      .references(() => productListings.id, { onDelete: 'cascade' }),
    variantId: text('variant_id').references(() => variants.id, { onDelete: 'set null' }),
    storeId: text('store_id')
      .notNull()
      .references(() => retailerStores.id, { onDelete: 'cascade' }),
    consumerId: text('consumer_id').references(() => consumers.id, { onDelete: 'set null' }),
    sessionId: text('session_id'),
    source: text('source'),
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    storeAtIdx: index('listing_views_store_at_idx').on(t.storeId, t.at),
    listingAtIdx: index('listing_views_listing_at_idx').on(t.listingId, t.at),
    variantAtIdx: index('listing_views_variant_at_idx').on(t.variantId, t.at),
  }),
);

export const cartEvents = pgTable(
  'cart_events',
  {
    id: text('id').primaryKey(),
    listingId: text('listing_id')
      .notNull()
      .references(() => productListings.id, { onDelete: 'cascade' }),
    variantId: text('variant_id')
      .notNull()
      .references(() => variants.id, { onDelete: 'cascade' }),
    storeId: text('store_id')
      .notNull()
      .references(() => retailerStores.id, { onDelete: 'cascade' }),
    consumerId: text('consumer_id')
      .notNull()
      .references(() => consumers.id, { onDelete: 'cascade' }),
    qty: integer('qty').notNull(),
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    storeAtIdx: index('cart_events_store_at_idx').on(t.storeId, t.at),
    listingAtIdx: index('cart_events_listing_at_idx').on(t.listingId, t.at),
    variantAtIdx: index('cart_events_variant_at_idx').on(t.variantId, t.at),
    positiveQty: check('cart_events_qty_positive', sql`${t.qty} > 0`),
  }),
);

export const listingViewsRelations = relations(listingViews, ({ one }) => ({
  listing: one(productListings, {
    fields: [listingViews.listingId],
    references: [productListings.id],
  }),
  variant: one(variants, { fields: [listingViews.variantId], references: [variants.id] }),
  store: one(retailerStores, { fields: [listingViews.storeId], references: [retailerStores.id] }),
}));

export const cartEventsRelations = relations(cartEvents, ({ one }) => ({
  listing: one(productListings, {
    fields: [cartEvents.listingId],
    references: [productListings.id],
  }),
  variant: one(variants, { fields: [cartEvents.variantId], references: [variants.id] }),
  store: one(retailerStores, { fields: [cartEvents.storeId], references: [retailerStores.id] }),
}));
