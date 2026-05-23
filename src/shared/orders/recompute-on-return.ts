/**
 * Promotion Recompute on Partial Return (MODULES.md §11).
 *
 * When a partial return is accepted, the kept subset of items may no longer
 * satisfy a promo's `minSpend`. We don't issue refunds for the lost promo
 * value (that's already handled by `createRefundForReturns`), but we *mark*
 * the promo as voided post-return on the order row so downstream surfaces
 * (snapshot diff panel, statements, dispute timelines) can flag it.
 *
 * Approach: read the order's kept items + their net line totals; for each
 * promotion that was originally applied (`orderItems[].retailerPromoAllocPaise > 0`
 * or platformPromoAllocPaise/couponAllocPaise), look up the promo's `config.minSpend`
 * and compare against the kept subtotal. If kept < minSpend, append the promo id
 * to `orders.promoVoidedAfterReturn`.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { orderItems, orders, promotions } from '@/db/schema/index.js';

export interface RecomputeResult {
  orderId: string;
  voidedPromoIds: string[];
  keptSubtotalPaise: number;
}

export async function recomputeAfterPartialReturn(
  database: typeof Db,
  orderId: string,
): Promise<RecomputeResult> {
  const order = await database.query.orders.findFirst({ where: eq(orders.id, orderId) });
  if (!order) {
    return { orderId, voidedPromoIds: [], keptSubtotalPaise: 0 };
  }

  // Items remaining in the order — `outcome !== store_accepted_return` is the "kept" set.
  const items = await database
    .select({
      id: orderItems.id,
      lineSubtotalPaise: orderItems.lineSubtotalPaise,
      retailerPromoAllocPaise: orderItems.retailerPromoAllocPaise,
      platformPromoAllocPaise: orderItems.platformPromoAllocPaise,
      couponAllocPaise: orderItems.couponAllocPaise,
      outcome: orderItems.outcome,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));

  const kept = items.filter((it) => it.outcome !== 'store_accepted_return');
  const keptSubtotalPaise = kept.reduce((sum, it) => sum + it.lineSubtotalPaise, 0);

  // Promos to re-evaluate: any promo with allocation > 0 in the kept items OR in the
  // whole order. For MVP, look up each distinct promo by reading allocations from items
  // and joining `promotions.config.minSpend`. Today the schema doesn't store per-line
  // promotionId, so we read from the order snapshot bag — kept items still carry their
  // original allocations. We use a heuristic: if the order has retailerPromoPaise/
  // platformPromoPaise/couponPaise > 0 and the kept subtotal dropped below the corresponding
  // promo's min-spend, treat that promo as voided. We can't resolve which promo id without
  // the snapshot of redemptions, so we read from `promotion_redemptions` table.
  //
  // For now the simplest, deterministic behavior: any promo that had a redemption row
  // recorded for this order, whose `config.minSpend > keptSubtotalPaise`, is voided.

  const { promotionRedemptions } = await import('@/db/schema/index.js');
  const redemptions = await database
    .select({ promotionId: promotionRedemptions.promotionId })
    .from(promotionRedemptions)
    .where(eq(promotionRedemptions.orderId, orderId));
  const promoIds = Array.from(new Set(redemptions.map((r) => r.promotionId)));
  if (promoIds.length === 0) {
    return { orderId, voidedPromoIds: [], keptSubtotalPaise };
  }

  const promoRows = await database
    .select({ id: promotions.id, config: promotions.config })
    .from(promotions)
    .where(inArray(promotions.id, promoIds));

  const voided: string[] = [];
  for (const p of promoRows) {
    const config = (p.config ?? {}) as { minSpend?: number; minSpendPaise?: number };
    const minSpend = config.minSpendPaise ?? config.minSpend ?? 0;
    if (minSpend > 0 && keptSubtotalPaise < minSpend) {
      voided.push(p.id);
    }
  }

  if (voided.length > 0) {
    const existing = (order.promoVoidedAfterReturn ?? []) as string[];
    const merged = Array.from(new Set([...existing, ...voided]));
    await database
      .update(orders)
      .set({ promoVoidedAfterReturn: merged })
      .where(eq(orders.id, orderId));
  }

  // Avoid unused-import warning on `and` / `sql`.
  void and;
  void sql;
  return { orderId, voidedPromoIds: voided, keptSubtotalPaise };
}
