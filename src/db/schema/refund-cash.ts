import { relations, sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { actorType, refundCashChannel } from './enums.js';
import { deliveryAgents } from './identity.js';
import { orders } from './orders.js';
import { reversePickups } from './reverse-pickups.js';
import { retailerStores } from './store.js';

/**
 * A physical cash refund handover — the money-moved record for the `cash` disbursement
 * rail.
 *
 * A COD order collected real notes, and there is no gateway payment to reverse, so the
 * only honest refund is cash back in the customer's hand. Two channels:
 *   driver_reverse_pickup — the driver hands the cash when collecting the returned goods
 *   store_counter         — the retailer hands it across the counter
 *
 * A handover is written when the cash physically moves, which for the driver channel is
 * BEFORE the refund exists (the store has not verified the return yet). The refund later
 * CLAIMS the handover and settles its cash leg against it. Allocation is derived —
 * `SUM(amount_paise)` over `refund_disbursements.cash_handover_id` under a `FOR UPDATE`
 * lock on this row — rather than kept in a counter column, because a counter can drift
 * out of agreement with the disbursements and a sum cannot.
 */
export const refundCashHandovers = pgTable(
  'refund_cash_handovers',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    /** Returns this cash covers — matched against a refund's returns when claimed. */
    returnIds: jsonb('return_ids').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    amountPaise: integer('amount_paise').notNull(),
    channel: refundCashChannel('channel').notNull(),
    reversePickupId: text('reverse_pickup_id').references(() => reversePickups.id),
    driverId: text('driver_id').references(() => deliveryAgents.id),
    storeId: text('store_id').references(() => retailerStores.id),
    recordedByActorType: actorType('recorded_by_actor_type').notNull(),
    recordedByActorId: text('recorded_by_actor_id').notNull(),
    proofPhotos: jsonb('proof_photos').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    note: text('note'),
    /** The instant the money changed hands — the cash leg's settledAt. */
    handedAt: timestamp('handed_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    orderIdx: index('refund_cash_handovers_order_idx').on(t.orderId),
    channelIdx: index('refund_cash_handovers_channel_idx').on(t.channel, t.handedAt),
    // At most one handover per pickup task: a replayed collect cannot pay twice.
    reversePickupIdx: uniqueIndex('refund_cash_handovers_reverse_pickup_idx')
      .on(t.reversePickupId)
      .where(sql`${t.reversePickupId} IS NOT NULL`),
    amountPositive: check('refund_cash_handovers_amount_positive', sql`${t.amountPaise} > 0`),
    // Exactly one channel, and each channel names exactly its own actor.
    channelGuard: check(
      'refund_cash_handovers_channel_guard',
      sql`(${t.channel} = 'driver_reverse_pickup' AND ${t.reversePickupId} IS NOT NULL
             AND ${t.driverId} IS NOT NULL AND ${t.storeId} IS NULL)
        OR (${t.channel} = 'store_counter' AND ${t.storeId} IS NOT NULL
             AND ${t.reversePickupId} IS NULL AND ${t.driverId} IS NULL)`,
    ),
  }),
);

export const refundCashHandoversRelations = relations(refundCashHandovers, ({ one }) => ({
  order: one(orders, { fields: [refundCashHandovers.orderId], references: [orders.id] }),
  reversePickup: one(reversePickups, {
    fields: [refundCashHandovers.reversePickupId],
    references: [reversePickups.id],
  }),
  driver: one(deliveryAgents, {
    fields: [refundCashHandovers.driverId],
    references: [deliveryAgents.id],
  }),
  store: one(retailerStores, {
    fields: [refundCashHandovers.storeId],
    references: [retailerStores.id],
  }),
}));
