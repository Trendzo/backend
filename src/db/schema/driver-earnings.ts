import { relations } from 'drizzle-orm';
import { integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { deliveryMethod } from './enums.js';
import { deliveryAgents } from './identity.js';
import { orders } from './orders.js';

/**
 * One earnings row per delivered order, per driver. `UNIQUE(orderId)` makes recording
 * idempotent — a re-transition to `delivered` (or a retry) never double-pays. Base +
 * incentive are read from `platform_config.driver_payout_table` at delivery time.
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
    deliveryMethod: deliveryMethod('delivery_method').notNull(),
    basePaise: integer('base_paise').notNull().default(0),
    incentivePaise: integer('incentive_paise').notNull().default(0),
    tipPaise: integer('tip_paise').notNull().default(0),
    totalPaise: integer('total_paise').notNull().default(0),
    earnedAt: timestamp('earned_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    orderIdx: uniqueIndex('driver_earnings_order_idx').on(t.orderId),
  }),
);

export const driverEarningsRelations = relations(driverEarnings, ({ one }) => ({
  driver: one(deliveryAgents, {
    fields: [driverEarnings.driverId],
    references: [deliveryAgents.id],
  }),
  order: one(orders, { fields: [driverEarnings.orderId], references: [orders.id] }),
}));
