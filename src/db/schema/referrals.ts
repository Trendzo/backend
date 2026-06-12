/**
 * Referrals — instant-redeem model. A consumer redeems a friend's referral code once;
 * both sides are credited loyalty points (kind='bonus'). One row per referee (the
 * unique referee FK is the double-redeem guard). `*_points` record the points actually
 * granted (0 if a side was rewards-banned at redeem time).
 */
import { relations } from 'drizzle-orm';
import { integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { consumers } from './identity.js';

export const referrals = pgTable(
  'referrals',
  {
    id: text('id').primaryKey(),
    referrerConsumerId: text('referrer_consumer_id')
      .notNull()
      .references(() => consumers.id, { onDelete: 'cascade' }),
    refereeConsumerId: text('referee_consumer_id')
      .notNull()
      .references(() => consumers.id, { onDelete: 'cascade' }),
    referrerPoints: integer('referrer_points').notNull(),
    refereePoints: integer('referee_points').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // A consumer can be referred at most once.
    refereeUnique: uniqueIndex('referrals_referee_idx').on(t.refereeConsumerId),
    referrerIdx: uniqueIndex('referrals_referrer_referee_idx').on(
      t.referrerConsumerId,
      t.refereeConsumerId,
    ),
  }),
);

export const referralsRelations = relations(referrals, ({ one }) => ({
  referrer: one(consumers, {
    fields: [referrals.referrerConsumerId],
    references: [consumers.id],
  }),
  referee: one(consumers, {
    fields: [referrals.refereeConsumerId],
    references: [consumers.id],
  }),
}));
