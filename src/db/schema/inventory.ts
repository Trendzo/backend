/**
 * §6 Inventory — adjustment + reservation tables.
 *
 * `variants` (in `products.ts`) carries `stock` and `reserved` columns. The
 * adjustment log records every change to either field with a reason code so
 * the History tab on /retailer/inventory has authoritative data once enabled
 * (the tab is marked "deferred" in the doc; the schema lands now so the
 * write side can start populating it immediately).
 *
 * `inventoryReservations` is the durable counterpart of the `reserved`
 * column — one row per cart-time hold, decremented on confirm or released
 * on cancel/timeout. Consumer-app integration deferred per doc; schema is
 * here so the write side has somewhere to land when it wires up.
 */

import { relations } from 'drizzle-orm';
import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { inventoryAdjustmentReason } from './enums.js';
import { variants } from './products.js';

/**
 * One row per stock change. `delta` is signed (+ for add, − for subtract).
 * `reason` carries an enum so reports can group by source (manual edits vs
 * imports vs order side-effects).
 */
export const inventoryAdjustments = pgTable('inventory_adjustments', {
  id: text('id').primaryKey(),
  variantId: text('variant_id')
    .notNull()
    .references(() => variants.id, { onDelete: 'cascade' }),
  delta: integer('delta').notNull(),
  newStock: integer('new_stock').notNull(),
  reason: inventoryAdjustmentReason('reason').notNull(),
  // Free-form actor reference — admin id, retailer account id, system, etc.
  actorKind: text('actor_kind').notNull(),
  actorId: text('actor_id'),
  // Optional cross-reference (order id for reservations / cancellations,
  // import-batch id for CSV uploads).
  refKind: text('ref_kind'),
  refId: text('ref_id'),
  at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  note: text('note'),
});

export const inventoryAdjustmentsRelations = relations(inventoryAdjustments, ({ one }) => ({
  variant: one(variants, {
    fields: [inventoryAdjustments.variantId],
    references: [variants.id],
  }),
}));

/**
 * One row per active reservation. The cart writes a row when a consumer
 * adds an item; on confirm the row is marked released_at + stock decremented;
 * on cancel/timeout the row is also released_at but stock stays. Cleaner
 * audit + lets the engine detect runaway holds.
 */
export const inventoryReservations = pgTable('inventory_reservations', {
  id: text('id').primaryKey(),
  variantId: text('variant_id')
    .notNull()
    .references(() => variants.id, { onDelete: 'cascade' }),
  qty: integer('qty').notNull(),
  // Cart / order id that owns the hold. Soft FK — orders/carts may live in
  // separate domain tables and the reservation engine cleans up via job.
  ownerKind: text('owner_kind').notNull(), // 'cart' | 'order'
  ownerId: text('owner_id').notNull(),
  reservedAt: timestamp('reserved_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
  releasedAt: timestamp('released_at', { withTimezone: true, mode: 'date' }),
  releaseReason: text('release_reason'), // 'confirmed' | 'cancelled' | 'timeout'
});

export const inventoryReservationsRelations = relations(inventoryReservations, ({ one }) => ({
  variant: one(variants, {
    fields: [inventoryReservations.variantId],
    references: [variants.id],
  }),
}));
