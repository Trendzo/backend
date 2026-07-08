import { relations, sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { reversePickupStatus } from './enums.js';
import { consumers, deliveryAgents } from './identity.js';
import { orders } from './orders.js';
import { retailerStores } from './store.js';

/**
 * Reverse pickup — a driver collects a consumer-initiated standard return from the
 * customer's home and carries it to the store. A separate task table, NOT an order
 * status: the forward order stays `delivered` throughout; the return lifecycle rides
 * `returns.storeDecision`.
 *
 * Broadcast model mirrors forward offers: `pending` + unassigned = claimable by any
 * driver (first atomic claim wins). `collect_otp` is the consumer→driver proof (the
 * consumer reads it out at the door, like the forward delivery OTP). On
 * deliver-to-store the task stamps the returns' verification window — from there the
 * store must verify or the lifecycle sweep auto-accepts.
 */
export const reversePickups = pgTable(
  'reverse_pickups',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    /** Return ids this task carries (one openReturn call = one task). */
    returnIds: jsonb('return_ids').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    consumerId: text('consumer_id')
      .notNull()
      .references(() => consumers.id),
    storeId: text('store_id')
      .notNull()
      .references(() => retailerStores.id),
    assignedDriverId: text('assigned_driver_id').references(() => deliveryAgents.id),
    status: reversePickupStatus('status').notNull().default('pending'),
    // Address snapshot copied from the order's address_*_snap at creation (same
    // PII-scrub story as the order snaps).
    addressLine1: text('address_line1').notNull(),
    addressLine2: text('address_line2'),
    addressCity: text('address_city'),
    addressPincode: text('address_pincode'),
    addressLat: doublePrecision('address_lat'),
    addressLng: doublePrecision('address_lng'),
    /** Human label of what to collect, e.g. "2 items: Kurta (M / Black), …". */
    itemsLabel: text('items_label').notNull(),
    /** Consumer→driver collection proof; surfaced only in the consumer's returns list. */
    collectOtp: text('collect_otp').notNull(),
    collectedPhotos: jsonb('collected_photos').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    assignedAt: timestamp('assigned_at', { withTimezone: true, mode: 'date' }),
    collectedAt: timestamp('collected_at', { withTimezone: true, mode: 'date' }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    poolIdx: index('reverse_pickups_pool_idx').on(t.status, t.createdAt),
    driverIdx: index('reverse_pickups_driver_idx').on(t.assignedDriverId, t.status),
    storeIdx: index('reverse_pickups_store_idx').on(t.storeId, t.status),
    consumerIdx: index('reverse_pickups_consumer_idx').on(t.consumerId),
    orderIdx: index('reverse_pickups_order_idx').on(t.orderId),
    assignedGuard: check(
      'reverse_pickups_assigned_guard',
      sql`${t.status} NOT IN ('assigned','collected') OR ${t.assignedDriverId} IS NOT NULL`,
    ),
  }),
);

/** Per-driver dismissal of a broadcast reverse-pickup offer (mirror of driver_offer_rejections). */
export const reversePickupRejections = pgTable(
  'reverse_pickup_rejections',
  {
    id: text('id').primaryKey(),
    driverId: text('driver_id')
      .notNull()
      .references(() => deliveryAgents.id),
    reversePickupId: text('reverse_pickup_id')
      .notNull()
      .references(() => reversePickups.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    driverTaskIdx: uniqueIndex('reverse_pickup_rejections_driver_task_idx').on(
      t.driverId,
      t.reversePickupId,
    ),
  }),
);

export const reversePickupsRelations = relations(reversePickups, ({ one }) => ({
  order: one(orders, { fields: [reversePickups.orderId], references: [orders.id] }),
  consumer: one(consumers, { fields: [reversePickups.consumerId], references: [consumers.id] }),
  store: one(retailerStores, { fields: [reversePickups.storeId], references: [retailerStores.id] }),
  assignedDriver: one(deliveryAgents, {
    fields: [reversePickups.assignedDriverId],
    references: [deliveryAgents.id],
  }),
}));
