import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { loyaltyTransactionKind, walletTransactionKind } from './enums.js';
import { consumers } from './identity.js';
import { orders } from './orders.js';
import { refunds } from './refunds.js';

/**
 * Wallet projection. `version` is the optimistic-lock counter for the CAS pattern:
 *
 *   read wallet → compute new balance → write txn with balanceAfter + walletVersionAfter
 *   → UPDATE wallet SET balance = ?, version = ? WHERE id = ? AND version = previousVersion
 *   → if rowcount = 0, retry the whole thing.
 *
 * This guarantees concurrent debits never overshoot a non-negative invariant.
 */
export const consumerWallets = pgTable(
  'consumer_wallets',
  {
    id: text('id').primaryKey(),
    consumerId: text('consumer_id')
      .notNull()
      .references(() => consumers.id),
    balancePaise: integer('balance_paise').notNull().default(0),
    version: integer('version').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    consumerIdx: uniqueIndex('consumer_wallets_consumer_idx').on(t.consumerId),
    nonNegativeGuard: check('consumer_wallets_balance_non_negative', sql`${t.balancePaise} >= 0`),
  }),
);

/**
 * Append-only ledger. Every write to a wallet has a matching transaction row.
 * `balanceAfterPaise` and `walletVersionAfter` are the snapshot for that exact write.
 */
export const walletTransactions = pgTable(
  'wallet_transactions',
  {
    id: text('id').primaryKey(),
    walletId: text('wallet_id')
      .notNull()
      .references(() => consumerWallets.id),
    kind: walletTransactionKind('kind').notNull(),
    amountPaise: integer('amount_paise').notNull(), // signed: + for credit, - for debit
    balanceAfterPaise: integer('balance_after_paise').notNull(),
    walletVersionAfter: integer('wallet_version_after').notNull(),
    refOrderId: text('ref_order_id').references(() => orders.id),
    refRefundId: text('ref_refund_id').references(() => refunds.id),
    refGiftCardId: text('ref_gift_card_id'), // gift card entity TBD
    note: text('note'),
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    walletAtIdx: index('wallet_transactions_wallet_at_idx').on(t.walletId, t.at),
    refOrderIdx: index('wallet_transactions_ref_order_idx').on(t.refOrderId),
    // CAS guard: two concurrent debits at the same wallet version cannot both succeed.
    versionUniqueIdx: uniqueIndex('wallet_transactions_wallet_version_idx').on(
      t.walletId,
      t.walletVersionAfter,
    ),
    // Sign of `amount_paise` must agree with `kind` — credits positive, debits negative.
    // `adjustment` may be either sign (manual correction).
    signByKindGuard: check(
      'wallet_transactions_sign_by_kind',
      sql`(${t.kind} IN ('top_up','refund_credit','gift_card_credit') AND ${t.amountPaise} > 0)
        OR (${t.kind} = 'debit' AND ${t.amountPaise} < 0)
        OR (${t.kind} = 'adjustment')`,
    ),
    balanceAfterGuard: check(
      'wallet_transactions_balance_after_non_negative',
      sql`${t.balanceAfterPaise} >= 0`,
    ),
  }),
);

/**
 * Loyalty ledger. Points integer (no fractions). Tier is computed from cumulative
 * positive earnings (not stored). `expiresAt` allows expiry policies later — null = no expiry.
 */
export const loyaltyTransactions = pgTable(
  'loyalty_transactions',
  {
    id: text('id').primaryKey(),
    consumerId: text('consumer_id')
      .notNull()
      .references(() => consumers.id),
    kind: loyaltyTransactionKind('kind').notNull(),
    points: integer('points').notNull(), // signed
    balanceAfterPoints: integer('balance_after_points').notNull(),
    refOrderId: text('ref_order_id').references(() => orders.id),
    note: text('note'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    consumerAtIdx: index('loyalty_transactions_consumer_at_idx').on(t.consumerId, t.at),
    // Sign of `points` must agree with `kind`. `redeem` debits; `earn`/`refund_credit`/`bonus`
    // credit; `adjustment` may be either sign.
    signByKindGuard: check(
      'loyalty_transactions_sign_by_kind',
      sql`(${t.kind} IN ('earn','refund_credit','bonus') AND ${t.points} > 0)
        OR (${t.kind} = 'redeem' AND ${t.points} < 0)
        OR (${t.kind} = 'adjustment')`,
    ),
    balanceAfterGuard: check(
      'loyalty_transactions_balance_after_non_negative',
      sql`${t.balanceAfterPoints} >= 0`,
    ),
  }),
);

// ===== Relations =====

export const consumerWalletsRelations = relations(consumerWallets, ({ one, many }) => ({
  consumer: one(consumers, {
    fields: [consumerWallets.consumerId],
    references: [consumers.id],
  }),
  transactions: many(walletTransactions),
}));

export const walletTransactionsRelations = relations(walletTransactions, ({ one }) => ({
  wallet: one(consumerWallets, {
    fields: [walletTransactions.walletId],
    references: [consumerWallets.id],
  }),
  order: one(orders, {
    fields: [walletTransactions.refOrderId],
    references: [orders.id],
  }),
  refund: one(refunds, {
    fields: [walletTransactions.refRefundId],
    references: [refunds.id],
  }),
}));

export const loyaltyTransactionsRelations = relations(loyaltyTransactions, ({ one }) => ({
  consumer: one(consumers, {
    fields: [loyaltyTransactions.consumerId],
    references: [consumers.id],
  }),
  order: one(orders, {
    fields: [loyaltyTransactions.refOrderId],
    references: [orders.id],
  }),
}));
