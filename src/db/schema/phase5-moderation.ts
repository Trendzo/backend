/**
 * §5 Catalog & Listings — moderation additions.
 *
 * `productListings` already exists in `products.ts`. The moderation queue
 * adds a flagging table (one row per flag, multiple flags per listing
 * possible), a per-flag appeal record, and a listing audit log so admin
 * edits to retailer-owned listings are traceable.
 */

import { relations } from 'drizzle-orm';
import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { moderationFlagSource, moderationFlagStatus } from './enums.js';
import { productListings } from './products.js';

/**
 * Flag against a listing. Source distinguishes admin/automation/user-report.
 * Status walks open → under_appeal → resolved_*.
 */
export const listingModerationFlags = pgTable('listing_moderation_flags', {
  id: text('id').primaryKey(),
  listingId: text('listing_id')
    .notNull()
    .references(() => productListings.id, { onDelete: 'cascade' }),
  source: moderationFlagSource('source').notNull(),
  // 'misleading_imagery' | 'price_dumping' | 'counterfeit' | …
  reasonCode: text('reason_code').notNull(),
  details: text('details'),
  // For source='user_report': the reporting consumer id.
  reportedByConsumerId: text('reported_by_consumer_id'),
  // For source='automation': the rule key that fired.
  ruleKey: text('rule_key'),
  status: moderationFlagStatus('status').notNull().default('open'),
  openedAt: timestamp('opened_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
  resolvedByAccountId: text('resolved_by_account_id'),
  resolutionNote: text('resolution_note'),
});

export const listingModerationFlagsRelations = relations(listingModerationFlags, ({ one }) => ({
  listing: one(productListings, {
    fields: [listingModerationFlags.listingId],
    references: [productListings.id],
  }),
}));

/**
 * Retailer appeals against a flag. One open appeal per flag at a time.
 */
export const listingModerationAppeals = pgTable('listing_moderation_appeals', {
  id: text('id').primaryKey(),
  flagId: text('flag_id')
    .notNull()
    .references(() => listingModerationFlags.id, { onDelete: 'cascade' }),
  retailerAccountId: text('retailer_account_id').notNull(),
  body: text('body').notNull(),
  attachmentUrls: jsonb('attachment_urls').$type<string[]>(),
  filedAt: timestamp('filed_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
  decidedByAccountId: text('decided_by_account_id'),
  outcome: text('outcome'), // 'upheld' | 'denied' — text so it can grow
  decisionNote: text('decision_note'),
});

export const listingModerationAppealsRelations = relations(
  listingModerationAppeals,
  ({ one }) => ({
    flag: one(listingModerationFlags, {
      fields: [listingModerationAppeals.flagId],
      references: [listingModerationFlags.id],
    }),
  }),
);

/**
 * Per-listing edit audit. Logs who changed what, used by both the listing
 * detail "Audit log" tab on the retailer side and the moderation overlay
 * on the admin side.
 */
export const listingAuditEntries = pgTable('listing_audit_entries', {
  id: text('id').primaryKey(),
  listingId: text('listing_id')
    .notNull()
    .references(() => productListings.id, { onDelete: 'cascade' }),
  // 'edit' | 'publish' | 'unpublish' | 'takedown' | 'restore' | 'retire'
  action: text('action').notNull(),
  actorKind: text('actor_kind').notNull(), // 'admin' | 'retailer' | 'system'
  actorId: text('actor_id'),
  before: jsonb('before').$type<Record<string, unknown> | null>(),
  after: jsonb('after').$type<Record<string, unknown> | null>(),
  at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  note: text('note'),
});

export const listingAuditEntriesRelations = relations(listingAuditEntries, ({ one }) => ({
  listing: one(productListings, {
    fields: [listingAuditEntries.listingId],
    references: [productListings.id],
  }),
}));
