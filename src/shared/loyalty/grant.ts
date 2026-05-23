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
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import {
  consumerFlags,
  loyaltyTransactions,
  orders,
  platformConfig,
} from '@/db/schema/index.js';
import type { LoyaltyConfig } from '@/shared/discounts/types.js';
import { loyaltyEarned } from '@/shared/discounts/loyalty.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';

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
 * Open = `resolved_at IS NULL`.
 */
export async function isRewardsBanned(consumerId: string): Promise<boolean> {
  const row = await db.query.consumerFlags.findFirst({
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
 * Latest loyalty balance for a consumer. Reads the most recent ledger row; null = 0.
 */
async function currentLoyaltyBalance(consumerId: string): Promise<number> {
  const last = await db.query.loyaltyTransactions.findFirst({
    where: eq(loyaltyTransactions.consumerId, consumerId),
    orderBy: desc(loyaltyTransactions.at),
    columns: { balanceAfterPoints: true },
  });
  return last?.balanceAfterPoints ?? 0;
}

/**
 * Credit loyalty for a delivered order. Idempotent — re-calling for an order whose
 * `loyaltyEarnedPoints` is already set is a no-op. Skips earn (returns 0) when the
 * consumer is rewards-banned. Returns the credited points (0 if skipped).
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

  if (await isRewardsBanned(order.consumerId)) {
    return 0;
  }

  const cfg = await loadLoyaltyConfig();
  const basis =
    order.itemsSubtotalPaise -
    order.retailerPromoPaise -
    order.platformPromoPaise -
    order.couponPaise -
    order.pointsRedeemedPaise;
  const points = loyaltyEarned(basis, cfg);
  if (points <= 0) return 0;

  const balanceBefore = await currentLoyaltyBalance(order.consumerId);
  const balanceAfter = balanceBefore + points;

  await db.transaction(async (tx) => {
    await tx.insert(loyaltyTransactions).values({
      id: newId(IdPrefix.LoyaltyTx),
      consumerId: order.consumerId,
      kind: 'earn',
      points,
      balanceAfterPoints: balanceAfter,
      refOrderId: order.id,
      note: `Earn on delivery ${order.id}`,
    });
    await tx
      .update(orders)
      .set({ loyaltyEarnedPoints: points })
      .where(eq(orders.id, order.id));
  });
  return points;
}

/**
 * Restore loyalty points redeemed on the refunded line items, then claw back the
 * proportional earned points. Both bypass the rewards-ban check — restoration is not a
 * new reward, and claw-back is a debit.
 *
 * Input: `pointsRedeemedClawbackPaise` = sum of `pointsClawbackPaise` across refund
 * lines (matches what `create-refund.ts` already computes). Earn claw-back is computed
 * pro-rata from `order.loyaltyEarnedPoints` × (refundLinesTotal / itemsSubtotal).
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
  let balance = await currentLoyaltyBalance(order.consumerId);
  let creditedPoints = 0;
  let clawedBackPoints = 0;

  // 1) Restore redeemed points (credit) — regardless of rewards_ban.
  if (input.pointsRedeemedClawbackPaise > 0) {
    creditedPoints = Math.floor(input.pointsRedeemedClawbackPaise / cfg.pointValuePaise);
  }

  // 2) Claw back proportional earned points (debit via adjustment).
  if (order.loyaltyEarnedPoints > 0 && order.itemsSubtotalPaise > 0) {
    const proportion = Math.min(1, input.refundedLinesTotalPaise / order.itemsSubtotalPaise);
    clawedBackPoints = Math.floor(order.loyaltyEarnedPoints * proportion);
    // Don't claw back more than the available balance + the credit we're about to add.
    // (Edge case: consumer already spent their earned points; we can't negate beyond zero.)
    const cap = balance + creditedPoints;
    if (clawedBackPoints > cap) clawedBackPoints = cap;
  }

  if (creditedPoints === 0 && clawedBackPoints === 0) {
    return { creditedPoints: 0, clawedBackPoints: 0 };
  }

  await db.transaction(async (tx) => {
    if (creditedPoints > 0) {
      balance += creditedPoints;
      await tx.insert(loyaltyTransactions).values({
        id: newId(IdPrefix.LoyaltyTx),
        consumerId: order.consumerId,
        kind: 'refund_credit',
        points: creditedPoints,
        balanceAfterPoints: balance,
        refOrderId: order.id,
        note: `Refund credit ${input.refundId}`,
      });
    }
    if (clawedBackPoints > 0) {
      balance -= clawedBackPoints;
      await tx.insert(loyaltyTransactions).values({
        id: newId(IdPrefix.LoyaltyTx),
        consumerId: order.consumerId,
        kind: 'adjustment',
        points: -clawedBackPoints,
        balanceAfterPoints: balance,
        refOrderId: order.id,
        note: `Earn claw-back on refund ${input.refundId}`,
      });
    }
  });

  return { creditedPoints, clawedBackPoints };
}

void sql;
