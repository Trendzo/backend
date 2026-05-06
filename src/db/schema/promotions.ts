import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  clubbingDefault,
  promotionAppliedTo,
  promotionDiscountType,
  promotionIssuerType,
  promotionMechanism,
  promotionStatus,
} from './enums.js';
import { consumers } from './identity.js';
import { retailerStores } from './store.js';
import { orders } from './orders.js';

/**
 * Generic promotion: offer (auto-apply), coupon (consumer enters code), or voucher
 * (single-use code, often issued individually). Discount math lives in the pricing engine;
 * this table just describes the rule.
 *
 * `scope` describes targeting (store, listing, category, etc.). `stackableWith` and
 * `nonStackable` are per-promotion overrides to the clubbing matrix; both are arrays of
 * promotion IDs (or `applied_to` keys for cross-mechanism rules).
 */
export const promotions = pgTable(
  'promotions',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id').references(() => retailerStores.id), // null = platform-wide
    name: text('name').notNull(),
    mechanism: promotionMechanism('mechanism').notNull(),
    discountType: promotionDiscountType('discount_type').notNull(),
    issuerType: promotionIssuerType('issuer_type').notNull(),
    appliedTo: promotionAppliedTo('applied_to').notNull(), // for clubbing classification
    scope: jsonb('scope').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    stackableWith: jsonb('stackable_with')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    nonStackable: jsonb('non_stackable')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    totalUses: integer('total_uses'), // null = unlimited
    redeemedCount: integer('redeemed_count').notNull().default(0),
    perConsumerLimit: integer('per_consumer_limit'), // null = unlimited

    validFrom: timestamp('valid_from', { withTimezone: true, mode: 'date' }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true, mode: 'date' }).notNull(),
    status: promotionStatus('status').notNull().default('draft'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    statusValidityIdx: index('promotions_status_validity_idx').on(
      t.status,
      t.validFrom,
      t.validUntil,
    ),
    storeIdx: index('promotions_store_idx').on(t.storeId),
    countersGuard: check(
      'promotions_counters_guard',
      sql`${t.redeemedCount} >= 0
        AND (${t.totalUses} IS NULL OR ${t.totalUses} >= 0)
        AND (${t.totalUses} IS NULL OR ${t.redeemedCount} <= ${t.totalUses})
        AND (${t.perConsumerLimit} IS NULL OR ${t.perConsumerLimit} >= 0)`,
    ),
    validityGuard: check('promotions_validity_guard', sql`${t.validUntil} > ${t.validFrom}`),
  }),
);

/**
 * Voucher code — globally unique. A voucher promotion typically has many codes, each
 * with its own usage cap (often 1).
 */
export const voucherCodes = pgTable(
  'voucher_codes',
  {
    id: text('id').primaryKey(),
    promotionId: text('promotion_id')
      .notNull()
      .references(() => promotions.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    totalUses: integer('total_uses'), // null = unlimited; usually 1
    redeemedCount: integer('redeemed_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    codeUniqueIdx: uniqueIndex('voucher_codes_code_idx').on(t.code),
    promotionIdx: index('voucher_codes_promotion_idx').on(t.promotionId),
    countersGuard: check(
      'voucher_codes_counters_guard',
      sql`${t.redeemedCount} >= 0
        AND (${t.totalUses} IS NULL OR ${t.totalUses} >= 0)
        AND (${t.totalUses} IS NULL OR ${t.redeemedCount} <= ${t.totalUses})`,
    ),
  }),
);

/**
 * Append-only redemption log. One row per (promotion, order) — composite unique guards
 * against double-application within an order.
 */
export const promotionRedemptions = pgTable(
  'promotion_redemptions',
  {
    id: text('id').primaryKey(),
    promotionId: text('promotion_id')
      .notNull()
      .references(() => promotions.id),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    consumerId: text('consumer_id')
      .notNull()
      .references(() => consumers.id),
    voucherCodeId: text('voucher_code_id').references(() => voucherCodes.id),
    amountAppliedPaise: integer('amount_applied_paise').notNull(),
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    promoOrderUniqueIdx: uniqueIndex('promotion_redemptions_promo_order_idx').on(
      t.promotionId,
      t.orderId,
    ),
    // ERD hot index: drives per-consumer-per-promotion usage cap check at checkout
    consumerPromoIdx: index('promotion_redemptions_consumer_promo_idx').on(
      t.consumerId,
      t.promotionId,
    ),
  }),
);

/**
 * Per-consumer usage counter. Composite PK enforces one row per (promotion, consumer);
 * `useCount` is the running total. Drives perConsumerLimit checks at checkout.
 */
export const promotionConsumerUsage = pgTable(
  'promotion_consumer_usage',
  {
    promotionId: text('promotion_id')
      .notNull()
      .references(() => promotions.id, { onDelete: 'cascade' }),
    consumerId: text('consumer_id')
      .notNull()
      .references(() => consumers.id),
    useCount: integer('use_count').notNull().default(0),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.promotionId, t.consumerId] }),
    useCountGuard: check('promotion_consumer_usage_count_guard', sql`${t.useCount} >= 0`),
  }),
);

/**
 * Default rule per (mechanismA, mechanismB) pair, canonical alphabetical order.
 * `always_allowed` rows cannot be turned off by per-promotion overrides.
 */
export const clubbingMatrixEntries = pgTable(
  'clubbing_matrix_entries',
  {
    id: text('id').primaryKey(),
    appliedToA: promotionAppliedTo('applied_to_a').notNull(),
    appliedToB: promotionAppliedTo('applied_to_b').notNull(),
    defaultValue: clubbingDefault('default_value').notNull(),
    note: text('note'),
  },
  (t) => ({
    pairUniqueIdx: uniqueIndex('clubbing_matrix_pair_idx').on(t.appliedToA, t.appliedToB),
    // Pairs must be canonically ordered so (X, Y) and (Y, X) can't both exist; without this,
    // unique-pair lookups become ambiguous depending on argument order at the call site.
    canonicalOrderGuard: check(
      'clubbing_matrix_canonical_order',
      sql`${t.appliedToA} <= ${t.appliedToB}`,
    ),
  }),
);

// ===== Relations =====

export const promotionsRelations = relations(promotions, ({ one, many }) => ({
  store: one(retailerStores, {
    fields: [promotions.storeId],
    references: [retailerStores.id],
  }),
  voucherCodes: many(voucherCodes),
  redemptions: many(promotionRedemptions),
}));

export const voucherCodesRelations = relations(voucherCodes, ({ one }) => ({
  promotion: one(promotions, {
    fields: [voucherCodes.promotionId],
    references: [promotions.id],
  }),
}));

export const promotionRedemptionsRelations = relations(promotionRedemptions, ({ one }) => ({
  promotion: one(promotions, {
    fields: [promotionRedemptions.promotionId],
    references: [promotions.id],
  }),
  order: one(orders, {
    fields: [promotionRedemptions.orderId],
    references: [orders.id],
  }),
  consumer: one(consumers, {
    fields: [promotionRedemptions.consumerId],
    references: [consumers.id],
  }),
  voucherCode: one(voucherCodes, {
    fields: [promotionRedemptions.voucherCodeId],
    references: [voucherCodes.id],
  }),
}));

export const promotionConsumerUsageRelations = relations(promotionConsumerUsage, ({ one }) => ({
  promotion: one(promotions, {
    fields: [promotionConsumerUsage.promotionId],
    references: [promotions.id],
  }),
  consumer: one(consumers, {
    fields: [promotionConsumerUsage.consumerId],
    references: [consumers.id],
  }),
}));
