import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { deliveryAgents } from './identity.js';
import { orders } from './orders.js';

/**
 * A driver dismissing a broadcast offer. Packed, unassigned orders are broadcast to every
 * active driver (the offers feed); a reject records a row here so that offer is filtered
 * out of that one driver's feed without removing it from the pool for everyone else.
 */
export const driverOfferRejections = pgTable(
  'driver_offer_rejections',
  {
    id: text('id').primaryKey(),
    driverId: text('driver_id')
      .notNull()
      .references(() => deliveryAgents.id),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    driverOrderIdx: uniqueIndex('driver_offer_rejections_driver_order_idx').on(t.driverId, t.orderId),
  }),
);
