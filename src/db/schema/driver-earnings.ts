import { relations, sql } from 'drizzle-orm';
import { integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { deliveryMethod } from './enums.js';
import { deliveryAgents } from './identity.js';
import { orders } from './orders.js';
import { reversePickups } from './reverse-pickups.js';

/**
 * One earnings row per delivered leg, per driver. Idempotency via two partial unique
 * indexes: forward deliveries are unique per order (reverse_pickup_id NULL); reverse
 * pickups are unique per task — the two can coexist on the same orderId (a driver who
 * delivered the order AND later collected its return earns both legs). Base +
 * incentive are read from `platform_config.driver_payout_table` at completion time.
 */
export const driverEarnings = pgTable(
  'driver_earnings',
  {
    id: text('id').primaryKey(),
    driverId: text('driver_id')
      .notNull()
      .references(() => deliveryAgents.id),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    /** Set only for reverse-pickup legs. */
    reversePickupId: text('reverse_pickup_id').references(() => reversePickups.id),
    deliveryMethod: deliveryMethod('delivery_method').notNull(),
    basePaise: integer('base_paise').notNull().default(0),
    incentivePaise: integer('incentive_paise').notNull().default(0),
    tipPaise: integer('tip_paise').notNull().default(0),
    totalPaise: integer('total_paise').notNull().default(0),
    earnedAt: timestamp('earned_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    orderIdx: uniqueIndex('driver_earnings_order_idx')
      .on(t.orderId)
      .where(sql`${t.reversePickupId} IS NULL`),
    reversePickupIdx: uniqueIndex('driver_earnings_reverse_pickup_idx')
      .on(t.reversePickupId)
      .where(sql`${t.reversePickupId} IS NOT NULL`),
  }),
);

export const driverEarningsRelations = relations(driverEarnings, ({ one }) => ({
  driver: one(deliveryAgents, {
    fields: [driverEarnings.driverId],
    references: [deliveryAgents.id],
  }),
  order: one(orders, { fields: [driverEarnings.orderId], references: [orders.id] }),
}));
