/**
 * Reels — short consumer-authored fashion videos with optional product tagging and a
 * social layer (likes / saves / comments). Mirrors the community-post moderation model
 * (status enum + takedown trio + guard check). Counters on `reels` are denormalised and
 * kept in sync inside the like/save/comment transactions.
 */
import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { reelCommentStatus, reelStatus } from './enums.js';
import { adminAccounts, consumers } from './identity.js';
import { productListings } from './products.js';

export const reels = pgTable(
  'reels',
  {
    id: text('id').primaryKey(),
    consumerId: text('consumer_id')
      .notNull()
      .references(() => consumers.id, { onDelete: 'cascade' }),
    caption: text('caption'),
    videoUrl: text('video_url').notNull(),
    // Cloudinary public_id — needed to delete the asset when a reel is hard-deleted.
    videoPublicId: text('video_public_id').notNull(),
    thumbnailUrl: text('thumbnail_url').notNull(),
    durationSec: integer('duration_sec'),
    width: integer('width'),
    height: integer('height'),
    bytes: integer('bytes'),
    // Product tag — nullable; ON DELETE SET NULL so a delisted product doesn't drop the reel.
    productId: text('product_id').references(() => productListings.id, { onDelete: 'set null' }),
    status: reelStatus('status').notNull().default('active'),
    // Denormalised counters — kept in sync in the like/save/comment transactions.
    likeCount: integer('like_count').notNull().default(0),
    commentCount: integer('comment_count').notNull().default(0),
    saveCount: integer('save_count').notNull().default(0),
    viewCount: integer('view_count').notNull().default(0),
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
    statusCreatedIdx: index('reels_status_created_idx').on(t.status, t.createdAt),
    consumerCreatedIdx: index('reels_consumer_created_idx').on(t.consumerId, t.createdAt),
    productIdx: index('reels_product_idx').on(t.productId),
    countersGuard: check(
      'reels_counters_guard',
      sql`${t.likeCount} >= 0 AND ${t.commentCount} >= 0 AND ${t.saveCount} >= 0 AND ${t.viewCount} >= 0`,
    ),
    takedownGuard: check(
      'reels_takedown_guard',
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

export const reelLikes = pgTable(
  'reel_likes',
  {
    id: text('id').primaryKey(),
    reelId: text('reel_id')
      .notNull()
      .references(() => reels.id, { onDelete: 'cascade' }),
    consumerId: text('consumer_id')
      .notNull()
      .references(() => consumers.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // One like per (reel, consumer) — duplicate insert is a 23505 no-op (idempotent like).
    reelConsumerUniq: uniqueIndex('reel_likes_reel_consumer_uniq').on(t.reelId, t.consumerId),
    consumerCreatedIdx: index('reel_likes_consumer_created_idx').on(t.consumerId, t.createdAt),
  }),
);

export const reelSaves = pgTable(
  'reel_saves',
  {
    id: text('id').primaryKey(),
    reelId: text('reel_id')
      .notNull()
      .references(() => reels.id, { onDelete: 'cascade' }),
    consumerId: text('consumer_id')
      .notNull()
      .references(() => consumers.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    reelConsumerUniq: uniqueIndex('reel_saves_reel_consumer_uniq').on(t.reelId, t.consumerId),
    consumerCreatedIdx: index('reel_saves_consumer_created_idx').on(t.consumerId, t.createdAt),
  }),
);

export const reelComments = pgTable(
  'reel_comments',
  {
    id: text('id').primaryKey(),
    reelId: text('reel_id')
      .notNull()
      .references(() => reels.id, { onDelete: 'cascade' }),
    consumerId: text('consumer_id')
      .notNull()
      .references(() => consumers.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    status: reelCommentStatus('status').notNull().default('active'),
    takedownReason: text('takedown_reason'),
    takedownByAdminId: text('takedown_by_admin_id').references(() => adminAccounts.id),
    takedownAt: timestamp('takedown_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    reelCreatedIdx: index('reel_comments_reel_created_idx').on(t.reelId, t.createdAt),
    consumerCreatedIdx: index('reel_comments_consumer_created_idx').on(t.consumerId, t.createdAt),
    takedownGuard: check(
      'reel_comments_takedown_guard',
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

// ===== Relations =====

export const reelsRelations = relations(reels, ({ one, many }) => ({
  consumer: one(consumers, { fields: [reels.consumerId], references: [consumers.id] }),
  product: one(productListings, { fields: [reels.productId], references: [productListings.id] }),
  takedownByAdmin: one(adminAccounts, {
    fields: [reels.takedownByAdminId],
    references: [adminAccounts.id],
  }),
  likes: many(reelLikes),
  saves: many(reelSaves),
  comments: many(reelComments),
}));

export const reelLikesRelations = relations(reelLikes, ({ one }) => ({
  reel: one(reels, { fields: [reelLikes.reelId], references: [reels.id] }),
  consumer: one(consumers, { fields: [reelLikes.consumerId], references: [consumers.id] }),
}));

export const reelSavesRelations = relations(reelSaves, ({ one }) => ({
  reel: one(reels, { fields: [reelSaves.reelId], references: [reels.id] }),
  consumer: one(consumers, { fields: [reelSaves.consumerId], references: [consumers.id] }),
}));

export const reelCommentsRelations = relations(reelComments, ({ one }) => ({
  reel: one(reels, { fields: [reelComments.reelId], references: [reels.id] }),
  consumer: one(consumers, { fields: [reelComments.consumerId], references: [consumers.id] }),
  takedownByAdmin: one(adminAccounts, {
    fields: [reelComments.takedownByAdminId],
    references: [adminAccounts.id],
  }),
}));
