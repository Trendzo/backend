/**
 * §20 Consumer Management — bans + community posts + product reviews + moderation queue.
 *
 * - `consumerBans` — per-surface ban with lift workflow (one active row per consumer+surface).
 * - `communityPosts`, `productReviews` — minimal social content with takedown status.
 * - `moderationReports` — queue of user/auto reports; polymorphic via targetType+targetId.
 * - `moderationActions` — append-only audit of admin decisions with before/after payloads.
 */
import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  communityPostStatus,
  consumerBanSurface,
  moderationActionKind,
  moderationReportSource,
  moderationReportStatus,
  moderationTargetType,
  productReviewStatus,
} from './enums.js';
import { adminAccounts, consumers } from './identity.js';
import { orders } from './orders.js';
import { productListings } from './products.js';

export const consumerBans = pgTable(
  'consumer_bans',
  {
    id: text('id').primaryKey(),
    consumerId: text('consumer_id')
      .notNull()
      .references(() => consumers.id, { onDelete: 'cascade' }),
    surface: consumerBanSurface('surface').notNull(),
    reason: text('reason').notNull(),
    createdByAdminId: text('created_by_admin_id')
      .notNull()
      .references(() => adminAccounts.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    liftedByAdminId: text('lifted_by_admin_id').references(() => adminAccounts.id),
    liftedAt: timestamp('lifted_at', { withTimezone: true, mode: 'date' }),
    liftReason: text('lift_reason'),
  },
  (t) => ({
    consumerIdx: index('consumer_bans_consumer_idx').on(t.consumerId),
    surfaceIdx: index('consumer_bans_surface_idx').on(t.surface),
    // Only one *active* ban per (consumer, surface). Partial unique on liftedAt IS NULL.
    activeUniq: uniqueIndex('consumer_bans_active_uniq')
      .on(t.consumerId, t.surface)
      .where(sql`${t.liftedAt} IS NULL`),
    liftGuard: check(
      'consumer_bans_lift_guard',
      sql`(${t.liftedAt} IS NULL AND ${t.liftedByAdminId} IS NULL)
        OR (${t.liftedAt} IS NOT NULL AND ${t.liftedByAdminId} IS NOT NULL)`,
    ),
  }),
);

export const communityPosts = pgTable(
  'community_posts',
  {
    id: text('id').primaryKey(),
    consumerId: text('consumer_id')
      .notNull()
      .references(() => consumers.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    media: jsonb('media').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    status: communityPostStatus('status').notNull().default('active'),
    takedownReason: text('takedown_reason'),
    takedownByAdminId: text('takedown_by_admin_id').references(() => adminAccounts.id),
    takedownAt: timestamp('takedown_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    consumerCreatedIdx: index('community_posts_consumer_created_idx').on(
      t.consumerId,
      t.createdAt,
    ),
    statusIdx: index('community_posts_status_idx').on(t.status),
    takedownGuard: check(
      'community_posts_takedown_guard',
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

export const productReviews = pgTable(
  'product_reviews',
  {
    id: text('id').primaryKey(),
    consumerId: text('consumer_id')
      .notNull()
      .references(() => consumers.id, { onDelete: 'cascade' }),
    listingId: text('listing_id')
      .notNull()
      .references(() => productListings.id, { onDelete: 'cascade' }),
    orderId: text('order_id').references(() => orders.id),
    rating: integer('rating').notNull(),
    body: text('body'),
    media: jsonb('media').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    status: productReviewStatus('status').notNull().default('active'),
    takedownReason: text('takedown_reason'),
    takedownByAdminId: text('takedown_by_admin_id').references(() => adminAccounts.id),
    takedownAt: timestamp('takedown_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    listingCreatedIdx: index('product_reviews_listing_created_idx').on(
      t.listingId,
      t.createdAt,
    ),
    consumerCreatedIdx: index('product_reviews_consumer_created_idx').on(
      t.consumerId,
      t.createdAt,
    ),
    statusIdx: index('product_reviews_status_idx').on(t.status),
    ratingRange: check('product_reviews_rating_range', sql`${t.rating} >= 1 AND ${t.rating} <= 5`),
    takedownGuard: check(
      'product_reviews_takedown_guard',
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

export const moderationReports = pgTable(
  'moderation_reports',
  {
    id: text('id').primaryKey(),
    targetType: moderationTargetType('target_type').notNull(),
    targetId: text('target_id').notNull(),
    reporterConsumerId: text('reporter_consumer_id').references(() => consumers.id),
    source: moderationReportSource('source').notNull(),
    reason: text('reason').notNull(),
    status: moderationReportStatus('status').notNull().default('pending'),
    decidedByAdminId: text('decided_by_admin_id').references(() => adminAccounts.id),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    decisionReason: text('decision_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    statusCreatedIdx: index('moderation_reports_status_created_idx').on(t.status, t.createdAt),
    targetIdx: index('moderation_reports_target_idx').on(t.targetType, t.targetId),
    decisionGuard: check(
      'moderation_reports_decision_guard',
      sql`(${t.status} = 'pending'
            AND ${t.decidedByAdminId} IS NULL
            AND ${t.decidedAt} IS NULL)
        OR (${t.status} <> 'pending'
            AND ${t.decidedByAdminId} IS NOT NULL
            AND ${t.decidedAt} IS NOT NULL)`,
    ),
  }),
);

export const moderationActions = pgTable(
  'moderation_actions',
  {
    id: text('id').primaryKey(),
    targetType: moderationTargetType('target_type').notNull(),
    targetId: text('target_id').notNull(),
    action: moderationActionKind('action').notNull(),
    adminId: text('admin_id')
      .notNull()
      .references(() => adminAccounts.id),
    reason: text('reason').notNull(),
    beforeJson: jsonb('before_json').$type<Record<string, unknown> | null>(),
    afterJson: jsonb('after_json').$type<Record<string, unknown> | null>(),
    reportId: text('report_id').references(() => moderationReports.id),
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    targetAtIdx: index('moderation_actions_target_at_idx').on(t.targetType, t.targetId, t.at),
    adminAtIdx: index('moderation_actions_admin_at_idx').on(t.adminId, t.at),
  }),
);

// ===== Relations =====

export const consumerBansRelations = relations(consumerBans, ({ one }) => ({
  consumer: one(consumers, {
    fields: [consumerBans.consumerId],
    references: [consumers.id],
  }),
  createdByAdmin: one(adminAccounts, {
    fields: [consumerBans.createdByAdminId],
    references: [adminAccounts.id],
  }),
  liftedByAdmin: one(adminAccounts, {
    fields: [consumerBans.liftedByAdminId],
    references: [adminAccounts.id],
  }),
}));

export const communityPostsRelations = relations(communityPosts, ({ one }) => ({
  consumer: one(consumers, {
    fields: [communityPosts.consumerId],
    references: [consumers.id],
  }),
  takedownByAdmin: one(adminAccounts, {
    fields: [communityPosts.takedownByAdminId],
    references: [adminAccounts.id],
  }),
}));

export const productReviewsRelations = relations(productReviews, ({ one }) => ({
  consumer: one(consumers, {
    fields: [productReviews.consumerId],
    references: [consumers.id],
  }),
  listing: one(productListings, {
    fields: [productReviews.listingId],
    references: [productListings.id],
  }),
  order: one(orders, {
    fields: [productReviews.orderId],
    references: [orders.id],
  }),
  takedownByAdmin: one(adminAccounts, {
    fields: [productReviews.takedownByAdminId],
    references: [adminAccounts.id],
  }),
}));

export const moderationReportsRelations = relations(moderationReports, ({ one }) => ({
  reporter: one(consumers, {
    fields: [moderationReports.reporterConsumerId],
    references: [consumers.id],
  }),
  decidedByAdmin: one(adminAccounts, {
    fields: [moderationReports.decidedByAdminId],
    references: [adminAccounts.id],
  }),
}));

export const moderationActionsRelations = relations(moderationActions, ({ one }) => ({
  admin: one(adminAccounts, {
    fields: [moderationActions.adminId],
    references: [adminAccounts.id],
  }),
  report: one(moderationReports, {
    fields: [moderationActions.reportId],
    references: [moderationReports.id],
  }),
}));
