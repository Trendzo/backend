/**
 * Lightweight anomaly heuristics for retailer promo monitoring (§13 A2).
 *
 * Run inline on perf-fetch (no cron). Detects three signals per promo:
 *   - velocity_spike: redemptions in the last hour > 5× rolling-24h avg-per-hour
 *   - refund_spike: refund rate of redeemed orders > 30%
 *   - consumer_concentration: top-1 consumer share > 50% of redemptions
 *
 * Returns the reasons list; an empty array means clean.
 */
import { and, count, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { orders, promotionRedemptions, refunds } from '@/db/schema/index.js';

export type AnomalyReason = 'velocity_spike' | 'refund_spike' | 'consumer_concentration';

const VELOCITY_MULTIPLIER = 5;
const REFUND_RATE_THRESHOLD_BP = 3000; // 30%
const CONCENTRATION_THRESHOLD_BP = 5000; // 50%

export type PromoAnomalyInput = {
  promotionId: string;
  redemptionsTotal: number;
  uniqueConsumers: number;
  topConsumerCount: number;
  refundRateBp: number;
};

export function detectAnomalies(input: PromoAnomalyInput, recentVsAvgRatio: number): AnomalyReason[] {
  const reasons: AnomalyReason[] = [];
  if (input.redemptionsTotal >= 10 && recentVsAvgRatio >= VELOCITY_MULTIPLIER) {
    reasons.push('velocity_spike');
  }
  if (input.redemptionsTotal >= 5 && input.refundRateBp >= REFUND_RATE_THRESHOLD_BP) {
    reasons.push('refund_spike');
  }
  if (input.redemptionsTotal >= 5 && input.uniqueConsumers >= 2) {
    const topShareBp = Math.round((input.topConsumerCount / input.redemptionsTotal) * 10000);
    if (topShareBp >= CONCENTRATION_THRESHOLD_BP) reasons.push('consumer_concentration');
  }
  return reasons;
}

/**
 * Compute the velocity ratio (redemptions last 1h / avg-per-hour over last 24h).
 * Cheap single query per promo set. Returns a Map keyed by promotionId.
 */
export async function loadVelocityRatios(promoIds: string[]): Promise<Map<string, number>> {
  if (promoIds.length === 0) return new Map();
  const now = new Date();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const since1h = new Date(now.getTime() - 60 * 60 * 1000);

  const last24 = await db
    .select({
      promotionId: promotionRedemptions.promotionId,
      c: count(),
    })
    .from(promotionRedemptions)
    .where(and(inArray(promotionRedemptions.promotionId, promoIds), gte(promotionRedemptions.at, since24h)))
    .groupBy(promotionRedemptions.promotionId);

  const last1 = await db
    .select({
      promotionId: promotionRedemptions.promotionId,
      c: count(),
    })
    .from(promotionRedemptions)
    .where(and(inArray(promotionRedemptions.promotionId, promoIds), gte(promotionRedemptions.at, since1h)))
    .groupBy(promotionRedemptions.promotionId);

  const map24 = new Map(last24.map((r) => [r.promotionId, Number(r.c)]));
  const map1 = new Map(last1.map((r) => [r.promotionId, Number(r.c)]));
  const out = new Map<string, number>();
  for (const id of promoIds) {
    const c24 = map24.get(id) ?? 0;
    const c1 = map1.get(id) ?? 0;
    const avgPerHour = c24 / 24;
    out.set(id, avgPerHour > 0 ? c1 / avgPerHour : 0);
  }
  return out;
}

/**
 * Compute top-consumer counts per promo. Returns Map<promotionId, topConsumerCount>.
 * Used by consumer-concentration anomaly heuristic.
 */
export async function loadTopConsumerCounts(promoIds: string[]): Promise<Map<string, number>> {
  if (promoIds.length === 0) return new Map();
  const rows = await db
    .select({
      promotionId: promotionRedemptions.promotionId,
      consumerId: promotionRedemptions.consumerId,
      c: count(),
    })
    .from(promotionRedemptions)
    .where(inArray(promotionRedemptions.promotionId, promoIds))
    .groupBy(promotionRedemptions.promotionId, promotionRedemptions.consumerId);
  const out = new Map<string, number>();
  for (const r of rows) {
    const cnum = Number(r.c);
    const prev = out.get(r.promotionId) ?? 0;
    if (cnum > prev) out.set(r.promotionId, cnum);
  }
  return out;
}

/**
 * Refund rate (basis points) per promo. refunded_orders / redeemed_orders × 10000.
 * Refund considered "refunded" when status NOT IN ('failed', 'cancelled').
 */
export async function loadRefundRates(promoIds: string[]): Promise<Map<string, number>> {
  if (promoIds.length === 0) return new Map();

  // Total redeemed orders per promo (distinct orderId — promotion_redemptions uniques on
  // (promotion_id, order_id) already, but be explicit).
  const redeemedRows = await db
    .select({
      promotionId: promotionRedemptions.promotionId,
      c: count(),
    })
    .from(promotionRedemptions)
    .where(inArray(promotionRedemptions.promotionId, promoIds))
    .groupBy(promotionRedemptions.promotionId);

  // Orders with at least one refund (non-failed/cancelled), broken down by promo.
  const refundedRows = await db
    .select({
      promotionId: promotionRedemptions.promotionId,
      c: sql<number>`COUNT(DISTINCT ${promotionRedemptions.orderId})::int`,
    })
    .from(promotionRedemptions)
    .innerJoin(refunds, eq(refunds.orderId, promotionRedemptions.orderId))
    .where(
      and(
        inArray(promotionRedemptions.promotionId, promoIds),
        sql`${refunds.status} != 'failed'`,
      ),
    )
    .groupBy(promotionRedemptions.promotionId);

  const redeemedMap = new Map(redeemedRows.map((r) => [r.promotionId, Number(r.c)]));
  const refundedMap = new Map(refundedRows.map((r) => [r.promotionId, Number(r.c)]));
  const out = new Map<string, number>();
  for (const id of promoIds) {
    const redeemed = redeemedMap.get(id) ?? 0;
    if (redeemed === 0) {
      out.set(id, 0);
      continue;
    }
    const refunded = refundedMap.get(id) ?? 0;
    out.set(id, Math.round((refunded / redeemed) * 10000));
  }
  return out;
}

/**
 * GMV influenced per promo — sum of order.grandTotalPaise for distinct orders that
 * carried this promo. Separate from the discount-given metric (amount_applied_paise).
 */
export async function loadGmvInfluenced(promoIds: string[]): Promise<Map<string, number>> {
  if (promoIds.length === 0) return new Map();
  const rows = await db
    .select({
      promotionId: promotionRedemptions.promotionId,
      gmv: sql<number>`COALESCE(SUM(${orders.grandTotalPaise}), 0)::bigint`,
    })
    .from(promotionRedemptions)
    .innerJoin(orders, eq(orders.id, promotionRedemptions.orderId))
    .where(inArray(promotionRedemptions.promotionId, promoIds))
    .groupBy(promotionRedemptions.promotionId);
  return new Map(rows.map((r) => [r.promotionId, Number(r.gmv)]));
}

/**
 * Unique-consumer counts per promo.
 */
export async function loadUniqueConsumers(promoIds: string[]): Promise<Map<string, number>> {
  if (promoIds.length === 0) return new Map();
  const rows = await db
    .select({
      promotionId: promotionRedemptions.promotionId,
      c: sql<number>`COUNT(DISTINCT ${promotionRedemptions.consumerId})::int`,
    })
    .from(promotionRedemptions)
    .where(inArray(promotionRedemptions.promotionId, promoIds))
    .groupBy(promotionRedemptions.promotionId);
  return new Map(rows.map((r) => [r.promotionId, Number(r.c)]));
}
