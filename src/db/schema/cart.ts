import { relations, sql } from 'drizzle-orm';
import { jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { consumers } from './identity.js';

/**
 * One cart per consumer. Items are embedded as JSON for MVP — keeps the read path single-row
 * and dodges the join overhead that a separate cart_item table would add. If we need
 * per-item analytics later, split it out.
 *
 * Stored variantIds reference catalog.variants but we do NOT FK them; cart contents are
 * tolerant of catalog churn. Validity is checked at /checkout/validate, not on every read.
 */
export const carts = pgTable(
  'carts',
  {
    id: text('id').primaryKey(),
    consumerId: text('consumer_id')
      .notNull()
      .references(() => consumers.id),
    items: jsonb('items')
      .$type<Array<{ variantId: string; qty: number }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    consumerIdx: uniqueIndex('carts_consumer_idx').on(t.consumerId),
  }),
);

export const cartsRelations = relations(carts, ({ one }) => ({
  consumer: one(consumers, {
    fields: [carts.consumerId],
    references: [consumers.id],
  }),
}));
