/**
 * §14 L3 — loyalty earn at delivery + credit-back on refund.
 *
 * Earn: when an order transitions to 'delivered', credit points based on post-discount
 * pre-tax subtotal × earnRateBp / pointValuePaise. Skipped when the consumer has an open
 * `rewards_ban` consumer-flag.
 *
 * Credit-back: when a refund is created, restore the loyalty points that were redeemed
 * on the refunded line items (sum of `pointsClawbackPaise` / pointValuePaise). This
 * proceeds **regardless** of any rewards_ban — restoration is not a new reward.
 *
 * Earn claw-back: refunds also reverse the earned portion proportionally (kind='adjustment')
 * so the consumer doesn't keep points for items they returned. This too bypasses the ban
 * check (it's a debit, not a credit).
 *
 * All point mutations go through applyLoyaltyDelta (CAS on the consumer_loyalty balance row);
 * this module never writes loyalty_transactions directly.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { consumerFlags, orders, platformConfig } from '@/db/schema/index.js';
import type { LoyaltyConfig } from '@/shared/discounts/types.js';
import { loyaltyEarned } from '@/shared/discounts/loyalty.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { applyLoyaltyDelta, loyaltyBalance } from './apply-delta.js';

/** Any executor with a relational `query` surface — the global db or an open transaction. */
type Executor = Pick<typeof db, 'query'>;

const LOYALTY_CONFIG_KEYS = [
  'loyalty_point_value_paise',
  'loyalty_earn_rate_bp',
  'loyalty_min_redeemable_points',
  'loyalty_max_redeem_fraction_bp',
] as const;

const DEFAULT_LOYALTY_CONFIG: LoyaltyConfig = {
  pointValuePaise: 100,
  earnRateBp: 10000,
  minRedeemablePoints: 100,
  maxRedeemFractionBp: 2000,
};

export async function loadLoyaltyConfig(): Promise<LoyaltyConfig> {
  const rows = await db.query.platformConfig.findMany({
    where: inArray(platformConfig.key, LOYALTY_CONFIG_KEYS as unknown as string[]),
  });
  const map = new Map(rows.map((r) => [r.key, r.value as number]));
  return {
    pointValuePaise: (map.get('loyalty_point_value_paise') as number) ?? DEFAULT_LOYALTY_CONFIG.pointValuePaise,
    earnRateBp: (map.get('loyalty_earn_rate_bp') as number) ?? DEFAULT_LOYALTY_CONFIG.earnRateBp,
    minRedeemablePoints:
      (map.get('loyalty_min_redeemable_points') as number) ?? DEFAULT_LOYALTY_CONFIG.minRedeemablePoints,
    maxRedeemFractionBp:
      (map.get('loyalty_max_redeem_fraction_bp') as number) ?? DEFAULT_LOYALTY_CONFIG.maxRedeemFractionBp,
  };
}

/**
 * Returns true iff the consumer has an open (unresolved) `rewards_ban` flag.
 * Open = `resolved_at IS NULL`. Pass a transaction as `exec` to read the check inside the
 * caller's snapshot.
 */
export async function isRewardsBanned(consumerId: string, exec: Executor = db): Promise<boolean> {
  const row = await exec.query.consumerFlags.findFirst({
    where: and(
      eq(consumerFlags.consumerId, consumerId),
      eq(consumerFlags.kind, 'rewards_ban'),
      isNull(consumerFlags.resolvedAt),
    ),
    columns: { id: true },
  });
  return Boolean(row);
}

/**
 * Credit loyalty for a delivered order. Idempotent under concurrency — the earn is claimed by
 * flipping `orders.loyaltyEarnedPoints` from 0 inside the transaction, so only one writer
 * credits. Skips earn (returns 0) when the consumer is rewards-banned. Returns credited points.
 *
 * Computation: post-promo, pre-tax basis = `itemsSubtotalPaise - retailerPromoPaise -
 * platformPromoPaise - couponPaise - pointsRedeemedPaise`. This matches the engine.
 */
export async function grantLoyaltyOnDelivery(orderId: string): Promise<number> {
  const order = await db.query.orders.findFirst({
    where: eq(orders.id, orderId),
  });
  if (!order) throw new AppError(404, ErrorCode.OrderNotFound, `Order ${orderId} not found`);
  if (order.loyaltyEarnedPoints > 0) return 0; // already credited
  if (order.status !== 'delivered') return 0; // gate — only delivered earns

  const cfg = await loadLoyaltyConfig();
  const basis =
    order.itemsSubtotalPaise -
    order.retailerPromoPaise -
    order.platformPromoPaise -
    order.couponPaise -
    order.pointsRedeemedPaise;
  const points = loyaltyEarned(basis, cfg);
  if (points <= 0) return 0;

  return db.transaction(async (tx) => {
    if (await isRewardsBanned(order.consumerId, tx)) return 0;

    // Claim the earn atomically: only the writer that flips loyaltyEarnedPoints 0 → points
    // credits, so a concurrent re-delivery webhook can't double-earn.
    const [claimed] = await tx
      .update(orders)
      .set({ loyaltyEarnedPoints: points })
      .where(and(eq(orders.id, order.id), eq(orders.loyaltyEarnedPoints, 0)))
      .returning({ id: orders.id });
    if (!claimed) return 0;

    await applyLoyaltyDelta(tx, {
      consumerId: order.consumerId,
      points,
      kind: 'earn',
      refOrderId: order.id,
      note: `Earn on delivery ${order.id}`,
    });
    return points;
  });
}

/**
 * Restore loyalty points redeemed on the refunded line items, then claw back the
 * proportional earned points. Both bypass the rewards-ban check — restoration is not a
 * new reward, and claw-back is a debit.
 *
 * Input: `pointsRedeemedClawbackPaise` = sum of `pointsClawbackPaise` across refund
 * lines (matches what `create-refund.ts` already computes). Earn claw-back is computed
 * pro-rata from `order.loyaltyEarnedPoints` × (refundLinesTotal / itemsSubtotal), then
 * capped to the live balance read inside the transaction so it can never overshoot zero.
 */
export async function creditBackOnRefund(input: {
  orderId: string;
  refundId: string;
  pointsRedeemedClawbackPaise: number;
  refundedLinesTotalPaise: number;
}): Promise<{ creditedPoints: number; clawedBackPoints: number }> {
  const order = await db.query.orders.findFirst({
    where: eq(orders.id, input.orderId),
  });
  if (!order) throw new AppError(404, ErrorCode.OrderNotFound, `Order ${input.orderId} not found`);

  const cfg = await loadLoyaltyConfig();

  // 1) Restore redeemed points (credit) — regardless of rewards_ban.
  const creditedPoints =
    input.pointsRedeemedClawbackPaise > 0
      ? Math.floor(input.pointsRedeemedClawbackPaise / cfg.pointValuePaise)
      : 0;

  // 2) Proportional earned-points claw-back (uncapped here; capped to live balance in the tx).
  const desiredClawback =
    order.loyaltyEarnedPoints > 0 && order.itemsSubtotalPaise > 0
      ? Math.floor(
          order.loyaltyEarnedPoints *
            Math.min(1, input.refundedLinesTotalPaise / order.itemsSubtotalPaise),
        )
      : 0;

  if (creditedPoints === 0 && desiredClawback === 0) {
    return { creditedPoints: 0, clawedBackPoints: 0 };
  }

  let clawedBackPoints = 0;
  await db.transaction(async (tx) => {
    if (creditedPoints > 0) {
      await applyLoyaltyDelta(tx, {
        consumerId: order.consumerId,
        points: creditedPoints,
        kind: 'refund_credit',
        refOrderId: order.id,
        note: `Refund credit ${input.refundId}`,
      });
    }
    if (desiredClawback > 0) {
      // Cap against the authoritative balance *after* the credit above — the consumer may
      // have already spent earned points, and we can't drive the balance below zero.
      const bal = await loyaltyBalance(tx, order.consumerId);
      clawedBackPoints = Math.min(desiredClawback, bal);
      if (clawedBackPoints > 0) {
        await applyLoyaltyDelta(tx, {
          consumerId: order.consumerId,
          points: -clawedBackPoints,
          kind: 'adjustment',
          refOrderId: order.id,
          note: `Earn claw-back on refund ${input.refundId}`,
        });
      }
    }
  });

  return { creditedPoints, clawedBackPoints };
}
