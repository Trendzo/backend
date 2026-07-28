import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { spinPlayStatus, spinRewardKind, spinWheelStatus } from './enums.js';
import { consumers } from './identity.js';
import { promotions, voucherCodes } from './promotions.js';

/**
 * A configurable "Spin & Win" wheel.
 *
 * Deliberately thin: the wheel owns presentation (which slices, in what order, what they
 * look like) and throttling (how often you may spin, how many prizes one account may ever
 * claim). It owns NO discount rules — a winning slice points at a `promotions` row, and
 * that promotion's own scope/config carries min order value, first-order-only,
 * per-consumer limit, tier filter, store scope and validity. One rules engine, not two.
 */
export const spinWheels = pgTable(
  'spin_wheels',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** `active` is the admin's enable/disable toggle. See the partial index below. */
    status: spinWheelStatus('status').notNull().default('draft'),
    /** Where the app may render it: the post-splash popup, the standalone screen, or both. */
    surface: text('surface').notNull().default('both'), // 'popup' | 'screen' | 'both'

    /**
     * Spins allowed per device per IST day. The device id is client-generated and survives
     * only until reinstall, so this shapes the experience ("come back tomorrow") rather
     * than defending the economics — `maxClaimsPerConsumer` does that.
     */
    spinsPerDevicePerDay: integer('spins_per_device_per_day').notNull().default(1),
    /**
     * Lifetime cap on prizes ONE ACCOUNT may claim from this wheel. Null = unlimited.
     * This is the real guard: reinstalling resets a device id, but a claim needs a
     * consumer, and consumers are phone-verified.
     */
    maxClaimsPerConsumer: integer('max_claims_per_consumer').default(1),
    /** When false the wheel is signed-in-only and the popup never fires for a guest. */
    guestSpinAllowed: boolean('guest_spin_allowed').notNull().default(true),
    /** How long a guest has to sign in and claim before the win lapses. */
    claimWindowHours: integer('claim_window_hours').notNull().default(168),

    validFrom: timestamp('valid_from', { withTimezone: true, mode: 'date' }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    /**
     * At most one live wheel, enforced by the database rather than by whoever remembers to
     * pause the old one. Activating a second wheel raises 23505, which the controller
     * turns into a clear "pause the current wheel first".
     */
    oneActiveIdx: uniqueIndex('spin_wheels_one_active_idx')
      .on(t.status)
      .where(sql`${t.status} = 'active'`),
    statusValidityIdx: index('spin_wheels_status_validity_idx').on(
      t.status,
      t.validFrom,
      t.validUntil,
    ),
    validityGuard: check('spin_wheels_validity_guard', sql`${t.validUntil} > ${t.validFrom}`),
    throttleGuard: check(
      'spin_wheels_throttle_guard',
      sql`${t.spinsPerDevicePerDay} >= 1
        AND ${t.claimWindowHours} >= 1
        AND (${t.maxClaimsPerConsumer} IS NULL OR ${t.maxClaimsPerConsumer} >= 1)`,
    ),
  }),
);

/**
 * One slice. `sortOrder` is the position on the rendered wheel, so the app can draw the
 * slices in the admin's order and the server can name a winner by index.
 *
 * `weightBp` is the odds, in basis points, and is NEVER sent to the client — the app used
 * to hold the weights and pick its own winner, which meant the odds were both public and
 * unenforceable. The server picks; the app animates to the index it is told.
 */
export const spinWheelSegments = pgTable(
  'spin_wheel_segments',
  {
    id: text('id').primaryKey(),
    wheelId: text('wheel_id')
      .notNull()
      .references(() => spinWheels.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull(),

    label: text('label').notNull(), // e.g. '20%'
    sublabel: text('sublabel'), // e.g. 'OFF'
    icon: text('icon'), // MaterialCommunityIcons name, matching the app's existing set
    colorHex: text('color_hex'), // null = the app alternates its default white/grey

    /** Basis points. The API layer asserts these sum to exactly 10000 across a wheel. */
    weightBp: integer('weight_bp').notNull(),

    rewardKind: spinRewardKind('reward_kind').notNull(),
    /** Set iff rewardKind='promotion'. Restricted, not cascaded: deleting a promotion that
     *  a live wheel points at should fail loudly rather than silently blank a slice. */
    promotionId: text('promotion_id').references(() => promotions.id),
    /** Set iff rewardKind='points'. Granted through applyLoyaltyDelta(kind:'bonus'). */
    points: integer('points'),

    /**
     * Global cap on how many times this slice may ever pay out — a jackpot you can afford
     * exactly five of. Null = unlimited. Once exhausted the slice keeps its position on
     * the wheel but is skipped by the draw and its weight is redistributed.
     */
    stockTotal: integer('stock_total'),
    stockIssued: integer('stock_issued').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    wheelOrderIdx: uniqueIndex('spin_wheel_segments_wheel_order_idx').on(t.wheelId, t.sortOrder),
    countersGuard: check(
      'spin_wheel_segments_counters_guard',
      sql`${t.weightBp} >= 0
        AND ${t.stockIssued} >= 0
        AND (${t.stockTotal} IS NULL OR ${t.stockTotal} >= 0)
        AND (${t.stockTotal} IS NULL OR ${t.stockIssued} <= ${t.stockTotal})`,
    ),
    /** A slice must actually be able to pay out what it claims to. */
    rewardGuard: check(
      'spin_wheel_segments_reward_guard',
      sql`(${t.rewardKind} = 'promotion' AND ${t.promotionId} IS NOT NULL AND ${t.points} IS NULL)
        OR (${t.rewardKind} = 'points' AND ${t.points} > 0 AND ${t.promotionId} IS NULL)
        OR (${t.rewardKind} = 'none' AND ${t.promotionId} IS NULL AND ${t.points} IS NULL)`,
    ),
  }),
);

/**
 * Append-only ledger of spins. Every spin writes a row, win or lose, because this table is
 * simultaneously the per-device daily throttle, the per-account claim cap, the guest's
 * proof of a pending prize, and the audit trail behind the admin's payout numbers.
 *
 * A guest's row lands with `consumerId` null and `status='pending_claim'`; signing in and
 * presenting `claimToken` fills both in. There is no separate "pending prize" table.
 */
export const spinPlays = pgTable(
  'spin_plays',
  {
    id: text('id').primaryKey(),
    wheelId: text('wheel_id')
      .notNull()
      .references(() => spinWheels.id),
    segmentId: text('segment_id')
      .notNull()
      .references(() => spinWheelSegments.id),

    /** Client-generated, stable per install. The only anonymous identity the app has. */
    deviceId: text('device_id').notNull(),
    /** Null until the winner signs in and claims. */
    consumerId: text('consumer_id').references(() => consumers.id),
    status: spinPlayStatus('status').notNull(),

    /**
     * Opaque bearer token handed to the spinner. Presenting it after login binds this win
     * to that account. Claim is idempotent on this column, so a retry over a flaky network
     * returns the same prize instead of minting a second one.
     */
    claimToken: text('claim_token').notNull(),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true, mode: 'date' }),

    /** Set at claim, for promotion prizes. */
    voucherCodeId: text('voucher_code_id').references(() => voucherCodes.id),
    /** Set at claim, for points prizes — mirrored here so the ledger is self-describing. */
    pointsAwarded: integer('points_awarded'),

    playedAt: timestamp('played_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    claimTokenIdx: uniqueIndex('spin_plays_claim_token_idx').on(t.claimToken),
    /** Drives the per-device daily cap — the hottest read on this table. */
    devicePlayedIdx: index('spin_plays_device_played_idx').on(t.deviceId, t.playedAt),
    /** Drives the lifetime per-account claim cap. */
    consumerIdx: index('spin_plays_consumer_idx')
      .on(t.consumerId, t.wheelId)
      .where(sql`${t.consumerId} IS NOT NULL`),
    wheelPlayedIdx: index('spin_plays_wheel_played_idx').on(t.wheelId, t.playedAt),
  }),
);

export const spinWheelsRelations = relations(spinWheels, ({ many }) => ({
  segments: many(spinWheelSegments),
  plays: many(spinPlays),
}));

export const spinWheelSegmentsRelations = relations(spinWheelSegments, ({ one }) => ({
  wheel: one(spinWheels, { fields: [spinWheelSegments.wheelId], references: [spinWheels.id] }),
  promotion: one(promotions, {
    fields: [spinWheelSegments.promotionId],
    references: [promotions.id],
  }),
}));

export const spinPlaysRelations = relations(spinPlays, ({ one }) => ({
  wheel: one(spinWheels, { fields: [spinPlays.wheelId], references: [spinWheels.id] }),
  segment: one(spinWheelSegments, {
    fields: [spinPlays.segmentId],
    references: [spinWheelSegments.id],
  }),
  consumer: one(consumers, { fields: [spinPlays.consumerId], references: [consumers.id] }),
  voucherCode: one(voucherCodes, {
    fields: [spinPlays.voucherCodeId],
    references: [voucherCodes.id],
  }),
}));
