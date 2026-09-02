/**
 * Native OS push device tokens (FCM/APNs), one row per app install per recipient.
 *
 * Kept separate from `push_subscriptions` (which is VAPID web-push shaped:
 * endpoint + p256dh + auth). A native device token is a single opaque string sent to
 * Firebase Admin's `sendEachForMulticast`. Used for TARGETED push: notify the one
 * consumer whose try-on window opened, or the one assigned driver a return was
 * requested from. Broadcast "new offer" push still rides the `driver-offers` FCM topic.
 */
import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { actorType, pushSubscriptionPlatform } from './enums.js';

export const deviceTokens = pgTable(
  'device_tokens',
  {
    id: text('id').primaryKey(),
    // 'consumer' | 'delivery_agent' (from the actor_type enum).
    recipientKind: actorType('recipient_kind').notNull(),
    recipientId: text('recipient_id').notNull(),
    token: text('token').notNull(),
    platform: pushSubscriptionPlatform('platform').notNull(), // ios | android
    appVersion: text('app_version'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    recipientIdx: index('device_tokens_recipient_idx').on(t.recipientKind, t.recipientId),
    // One live row per token; re-registering an existing token reactivates it.
    tokenActiveUniq: uniqueIndex('device_tokens_token_active_uniq')
      .on(t.token)
      .where(sql`${t.revokedAt} IS NULL`),
  }),
);
