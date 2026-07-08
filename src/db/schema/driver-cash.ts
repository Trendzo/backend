import { relations, sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { driverCashDepositStatus, driverCashEntryKind } from './enums.js';
import { adminAccounts, deliveryAgents } from './identity.js';
import { orders } from './orders.js';

/**
 * Driver COD cash accounting.
 *
 * `driver_cash_ledger` is APPEND-ONLY — the single source of truth for how much
 * cash a driver is holding:
 *   collected  +amount  written when a COD payment settles on a driver-delivered
 *                       order (settleCodPaymentOnDelivery)
 *   deposited  -amount  written when an admin CONFIRMS a deposit (never at request)
 * Outstanding = Σ(collected) − Σ(deposited). Rows are never updated or deleted.
 *
 * `driver_cash_deposits` is the workflow around handing the cash to the ops desk:
 * driver declares an amount (pending) → admin confirms (ledger entry lands) or
 * rejects (nothing moves).
 */
export const driverCashLedger = pgTable(
  'driver_cash_ledger',
  {
    id: text('id').primaryKey(),
    driverId: text('driver_id')
      .notNull()
      .references(() => deliveryAgents.id),
    entryKind: driverCashEntryKind('entry_kind').notNull(),
    /** Always positive; the kind decides the sign in the balance. */
    amountPaise: integer('amount_paise').notNull(),
    /** Source order for 'collected' entries. */
    orderId: text('order_id').references(() => orders.id),
    /** Source deposit for 'deposited' entries. */
    depositId: text('deposit_id'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    driverIdx: index('driver_cash_ledger_driver_idx').on(t.driverId, t.createdAt),
    // One 'collected' entry per order — settle is flip-guarded, this is the backstop.
    collectedOrderIdx: uniqueIndex('driver_cash_ledger_collected_order_idx')
      .on(t.orderId)
      .where(sql`${t.entryKind} = 'collected' AND ${t.orderId} IS NOT NULL`),
    // One 'deposited' entry per deposit — confirm is flip-guarded, this is the backstop.
    depositIdx: uniqueIndex('driver_cash_ledger_deposit_idx')
      .on(t.depositId)
      .where(sql`${t.entryKind} = 'deposited' AND ${t.depositId} IS NOT NULL`),
  }),
);

export const driverCashDeposits = pgTable(
  'driver_cash_deposits',
  {
    id: text('id').primaryKey(),
    driverId: text('driver_id')
      .notNull()
      .references(() => deliveryAgents.id),
    amountPaise: integer('amount_paise').notNull(),
    status: driverCashDepositStatus('status').notNull().default('pending'),
    /** Driver-side note ("evening shift cash"). */
    note: text('note'),
    /** Admin decision context. */
    decidedByAdminId: text('decided_by_admin_id').references(() => adminAccounts.id),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    adminNote: text('admin_note'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    driverStatusIdx: index('driver_cash_deposits_driver_status_idx').on(t.driverId, t.status),
    statusIdx: index('driver_cash_deposits_status_idx').on(t.status, t.createdAt),
    // At most ONE pending deposit per driver — keeps the ops queue unambiguous.
    pendingPerDriverIdx: uniqueIndex('driver_cash_deposits_pending_idx')
      .on(t.driverId)
      .where(sql`${t.status} = 'pending'`),
  }),
);

export const driverCashLedgerRelations = relations(driverCashLedger, ({ one }) => ({
  driver: one(deliveryAgents, {
    fields: [driverCashLedger.driverId],
    references: [deliveryAgents.id],
  }),
  order: one(orders, { fields: [driverCashLedger.orderId], references: [orders.id] }),
}));

export const driverCashDepositsRelations = relations(driverCashDeposits, ({ one }) => ({
  driver: one(deliveryAgents, {
    fields: [driverCashDeposits.driverId],
    references: [deliveryAgents.id],
  }),
}));
