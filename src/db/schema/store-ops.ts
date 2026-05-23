/**
 * §4 Store Operations — schema additions.
 *
 * Holiday calendar (closed-date markers feeding the store-hours engine),
 * notification preferences (per-channel opt-in + dashboard tile picker), and
 * the unified notification inbox (one row per pushed notification per
 * recipient account).
 */

import { relations } from 'drizzle-orm';
import {
  boolean,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { actorType, notificationChannel, notificationKind } from './enums.js';
import { retailerStores } from './store.js';

/**
 * Closed-date markers. `date` is stored as a `DATE`-shaped text in ISO
 * format (YYYY-MM-DD) so a unique constraint with storeId is trivial and
 * the value is timezone-stable across the country.
 */
export const storeHolidayClosures = pgTable(
  'store_holiday_closures',
  {
    storeId: text('store_id')
      .notNull()
      .references(() => retailerStores.id, { onDelete: 'cascade' }),
    date: text('date').notNull(), // YYYY-MM-DD
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    createdByAccountId: text('created_by_account_id'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.storeId, t.date] }),
  }),
);

export const storeHolidayClosuresRelations = relations(storeHolidayClosures, ({ one }) => ({
  store: one(retailerStores, {
    fields: [storeHolidayClosures.storeId],
    references: [retailerStores.id],
  }),
}));

/**
 * Per-account notification preferences. Polymorphic by `accountKind` so the
 * same table covers retailer and admin accounts.
 *
 * `dashboardTiles` is a list of tile keys the user wants surfaced on their
 * dashboard (orders, returns, payouts, kyc, etc.).
 */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    accountKind: actorType('account_kind').notNull(),
    accountId: text('account_id').notNull(),
    pushEnabled: boolean('push_enabled').notNull().default(true),
    emailEnabled: boolean('email_enabled').notNull().default(true),
    dailyDigestEnabled: boolean('daily_digest_enabled').notNull().default(false),
    smsEnabled: boolean('sms_enabled').notNull().default(false),
    language: text('language').notNull().default('en-IN'),
    dashboardTiles: jsonb('dashboard_tiles').$type<string[]>(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.accountKind, t.accountId] }),
  }),
);

export const notificationPreferencesRelations = relations(notificationPreferences, () => ({}));

/**
 * Per-account inbox. One row per notification per recipient. `channel`
 * tracks how the notification was delivered (inbox-only, also pushed,
 * also emailed). `read_at` flips on read.
 */
export const notifications = pgTable('notifications', {
  id: text('id').primaryKey(),
  recipientKind: actorType('recipient_kind').notNull(),
  recipientId: text('recipient_id').notNull(),
  kind: notificationKind('kind').notNull(),
  channel: notificationChannel('channel').notNull().default('inbox'),
  title: text('title').notNull(),
  body: text('body'),
  deepLink: text('deep_link'),
  // Free-form payload for client-side enrichment (e.g. the order id, return
  // id, etc.) without needing a separate join.
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }),
  // Hard delete is implemented by setting `deletedAt`; the row stays so the
  // analytics history is preserved.
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
});

export const notificationsRelations = relations(notifications, () => ({}));
