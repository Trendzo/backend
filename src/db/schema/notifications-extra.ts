/**
 * §22 Notifications System — push subscriptions, banners, email outbox, push attempts.
 *
 * - `push_subscriptions` — per-recipient web/native push endpoints. Idempotent by endpoint URL.
 * - `push_attempts` — append-only log of dispatch attempts (web-push wire integration deferred).
 * - `banners` — admin-pushed announcements + per-retailer/admin scoped messages with severity.
 * - `email_outbox` — captured outgoing emails (SMTP integration deferred).
 */
import { relations, sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  actorType,
  bannerScope,
  bannerSeverity,
  emailOutboxStatus,
  notificationKind,
  pushAttemptStatus,
  pushSubscriptionPlatform,
} from './enums.js';
import { notifications } from './store-ops.js';
import { retailerStores } from './store.js';

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: text('id').primaryKey(),
    recipientKind: actorType('recipient_kind').notNull(),
    recipientId: text('recipient_id').notNull(),
    platform: pushSubscriptionPlatform('platform').notNull(),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh'),
    auth: text('auth'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    recipientIdx: index('push_subscriptions_recipient_idx').on(t.recipientKind, t.recipientId),
    endpointActiveUniq: uniqueIndex('push_subscriptions_endpoint_active_uniq')
      .on(t.endpoint)
      .where(sql`${t.revokedAt} IS NULL`),
  }),
);

export const pushAttempts = pgTable(
  'push_attempts',
  {
    id: text('id').primaryKey(),
    notificationId: text('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    subscriptionId: text('subscription_id')
      .notNull()
      .references(() => pushSubscriptions.id, { onDelete: 'cascade' }),
    status: pushAttemptStatus('status').notNull().default('pending'),
    error: text('error'),
    attemptedAt: timestamp('attempted_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    notificationIdx: index('push_attempts_notification_idx').on(t.notificationId),
    subAtIdx: index('push_attempts_sub_at_idx').on(t.subscriptionId, t.attemptedAt),
  }),
);

export const banners = pgTable(
  'banners',
  {
    id: text('id').primaryKey(),
    scope: bannerScope('scope').notNull(),
    storeId: text('store_id').references(() => retailerStores.id, { onDelete: 'cascade' }),
    severity: bannerSeverity('severity').notNull().default('info'),
    title: text('title').notNull(),
    body: text('body'),
    deepLink: text('deep_link'),
    dismissible: text('dismissible').notNull().default('true'),
    activeFrom: timestamp('active_from', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    activeUntil: timestamp('active_until', { withTimezone: true, mode: 'date' }),
    createdByAdminId: text('created_by_admin_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    scopeActiveIdx: index('banners_scope_active_idx').on(t.scope, t.activeFrom),
    storeIdx: index('banners_store_idx').on(t.storeId),
  }),
);

export const bannerDismissals = pgTable(
  'banner_dismissals',
  {
    id: text('id').primaryKey(),
    bannerId: text('banner_id')
      .notNull()
      .references(() => banners.id, { onDelete: 'cascade' }),
    accountKind: actorType('account_kind').notNull(),
    accountId: text('account_id').notNull(),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    bannerAccountUniq: uniqueIndex('banner_dismissals_banner_account_uniq').on(
      t.bannerId,
      t.accountKind,
      t.accountId,
    ),
  }),
);

export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: text('id').primaryKey(),
    recipientKind: actorType('recipient_kind').notNull(),
    recipientId: text('recipient_id').notNull(),
    toEmail: text('to_email').notNull(),
    subject: text('subject').notNull(),
    bodyText: text('body_text').notNull(),
    bodyHtml: text('body_html'),
    kind: notificationKind('kind').notNull().default('system'),
    status: emailOutboxStatus('status').notNull().default('pending'),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    queuedAt: timestamp('queued_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    failedAt: timestamp('failed_at', { withTimezone: true, mode: 'date' }),
    failureReason: text('failure_reason'),
  },
  (t) => ({
    recipientIdx: index('email_outbox_recipient_idx').on(t.recipientKind, t.recipientId),
    statusIdx: index('email_outbox_status_idx').on(t.status),
  }),
);

export const pushSubscriptionsRelations = relations(pushSubscriptions, () => ({}));
export const pushAttemptsRelations = relations(pushAttempts, ({ one }) => ({
  notification: one(notifications, {
    fields: [pushAttempts.notificationId],
    references: [notifications.id],
  }),
  subscription: one(pushSubscriptions, {
    fields: [pushAttempts.subscriptionId],
    references: [pushSubscriptions.id],
  }),
}));
export const bannersRelations = relations(banners, ({ one, many }) => ({
  store: one(retailerStores, {
    fields: [banners.storeId],
    references: [retailerStores.id],
  }),
  dismissals: many(bannerDismissals),
}));
export const bannerDismissalsRelations = relations(bannerDismissals, ({ one }) => ({
  banner: one(banners, { fields: [bannerDismissals.bannerId], references: [banners.id] }),
}));
export const emailOutboxRelations = relations(emailOutbox, () => ({}));
