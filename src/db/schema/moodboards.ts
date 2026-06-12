/**
 * Moodboards — consumer-created collections of saved products ("save and organize
 * outfit combinations"). Owner-private by default; can be made public + shared.
 * Items reference products at LISTING level (a board saves a product from a store;
 * variant choice happens at checkout). Mirrors the community_posts moderation model:
 * a public board can be taken down by an admin (status + takedown guard).
 */
import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { moodboardStatus } from './enums.js';
import { adminAccounts, consumers } from './identity.js';
import { productListings } from './products.js';

export const moodboards = pgTable(
  'moodboards',
  {
    id: text('id').primaryKey(),
    consumerId: text('consumer_id')
      .notNull()
      .references(() => consumers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    note: text('note'),
    isPublic: boolean('is_public').notNull().default(false),
    status: moodboardStatus('status').notNull().default('active'),
    takedownReason: text('takedown_reason'),
    takedownByAdminId: text('takedown_by_admin_id').references(() => adminAccounts.id),
    takedownAt: timestamp('takedown_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    consumerCreatedIdx: index('moodboards_consumer_created_idx').on(t.consumerId, t.createdAt),
    statusIdx: index('moodboards_status_idx').on(t.status),
    publicIdx: index('moodboards_public_idx').on(t.isPublic),
    takedownGuard: check(
      'moodboards_takedown_guard',
      sql`(${t.status} <> 'taken_down'
            AND ${t.takedownReason} IS NULL
            AND ${t.takedownByAdminId} IS NULL
            AND ${t.takedownAt} IS NULL)
        OR (${t.status} = 'taken_down'
            AND ${t.takedownReason} IS NOT NULL
            AND ${t.takedownByAdminId} IS NOT NULL
            AND ${t.takedownAt} IS NOT NULL)`,
    ),
  }),
);

export const moodboardItems = pgTable(
  'moodboard_items',
  {
    id: text('id').primaryKey(),
    moodboardId: text('moodboard_id')
      .notNull()
      .references(() => moodboards.id, { onDelete: 'cascade' }),
    listingId: text('listing_id')
      .notNull()
      .references(() => productListings.id),
    sortOrder: integer('sort_order').notNull().default(0),
    addedAt: timestamp('added_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    moodboardIdx: index('moodboard_items_moodboard_idx').on(t.moodboardId),
    // One product per board — adding a duplicate listing is a no-op error.
    boardListingUnique: uniqueIndex('moodboard_items_board_listing_idx').on(
      t.moodboardId,
      t.listingId,
    ),
  }),
);

export const moodboardsRelations = relations(moodboards, ({ one, many }) => ({
  consumer: one(consumers, {
    fields: [moodboards.consumerId],
    references: [consumers.id],
  }),
  takedownByAdmin: one(adminAccounts, {
    fields: [moodboards.takedownByAdminId],
    references: [adminAccounts.id],
  }),
  items: many(moodboardItems),
}));

export const moodboardItemsRelations = relations(moodboardItems, ({ one }) => ({
  moodboard: one(moodboards, {
    fields: [moodboardItems.moodboardId],
    references: [moodboards.id],
  }),
  listing: one(productListings, {
    fields: [moodboardItems.listingId],
    references: [productListings.id],
  }),
}));
