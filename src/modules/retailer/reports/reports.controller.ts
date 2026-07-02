import { and, count, desc, eq, gte, inArray, isNull, sql, sum } from 'drizzle-orm';
import { db } from '@/db/client.js';
import {
  cartEvents,
  customerIssues,
  listingViews,
  orderItems,
  orders,
  payouts,
  productListings,
  promotionRedemptions,
  promotions,
  refunds,
  retailerAccounts,
  retailerStores,
  returns as returnsTable,
  variants,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { wrapReport } from '@/shared/reports/meta.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';

type Auth = AccessTokenPayload;

async function getStoreId(retailerId: string): Promise<string> {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
  });
  if (!retailer?.storeId) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  return retailer.storeId;
}

/**
 * Resolve the storeId for a report request:
 *   - If `storeIdOverride` is provided (admin drill-in), validate the store exists.
 *   - Otherwise, look it up from the retailer auth subject.
 */
export async function resolveStoreId(input: {
  auth: Auth;
  storeIdOverride?: string | undefined;
}): Promise<string> {
  if (input.storeIdOverride) {
    const store = await db.query.retailerStores.findFirst({
      where: eq(retailerStores.id, input.storeIdOverride),
      columns: { id: true },
    });
    if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
    return store.id;
  }
  return getStoreId(input.auth.sub);
}

export async function getSales(input: { auth: Auth; storeIdOverride?: string | undefined }) {
  const storeId = await resolveStoreId(input);
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      bucket: sql<string>`to_char(${orders.placedAt}, 'YYYY-MM-DD')`,
      ordersCount: count(),
      grossPaise: sum(orders.grandTotalPaise),
      platformFeeBpSnap: sql<number>`MAX(${orders.platformFeeBpSnap})`,
    })
    .from(orders)
    .where(and(eq(orders.storeId, storeId), gte(orders.placedAt, since)))
    .groupBy(sql`to_char(${orders.placedAt}, 'YYYY-MM-DD')`)
    .orderBy(sql`to_char(${orders.placedAt}, 'YYYY-MM-DD')`);

  return ok(wrapReport(
    rows.map((r) => {
      const gross = Number(r.grossPaise ?? 0);
      const feeBp = r.platformFeeBpSnap ?? 0;
      const commission = Math.round((gross * feeBp) / 10000);
      return {
        bucket: r.bucket,
        ordersCount: Number(r.ordersCount),
        grossPaise: gross,
        netPaise: gross - commission,
      };
    }),
  ));
}

export async function getPerformance(input: { auth: Auth; storeIdOverride?: string | undefined }) {
  const storeId = await resolveStoreId(input);
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      bucket: sql<string>`to_char(${orders.placedAt}, 'YYYY-MM-DD')`,
      total: count(),
      accepted: sql<number>`COUNT(${orders.acceptedAt})::int`,
      avgAcceptMs: sql<number>`COALESCE(
        AVG(EXTRACT(EPOCH FROM (${orders.acceptedAt} - ${orders.placedAt})) * 1000)::int, 0)`,
      avgE2eMs: sql<number>`COALESCE(
        AVG(EXTRACT(EPOCH FROM (${orders.deliveredAt} - ${orders.placedAt})) * 1000)::int, 0)`,
    })
    .from(orders)
    .where(and(eq(orders.storeId, storeId), gte(orders.placedAt, since)))
    .groupBy(sql`to_char(${orders.placedAt}, 'YYYY-MM-DD')`)
    .orderBy(sql`to_char(${orders.placedAt}, 'YYYY-MM-DD')`);

  return ok(wrapReport(
    rows.map((r) => ({
      bucket: r.bucket,
      acceptanceRateBp: r.total > 0 ? Math.round((r.accepted / r.total) * 10000) : 0,
      avgTimeToAcceptMs: Number(r.avgAcceptMs ?? 0),
      avgTimeToPackMs: 0,
      avgTimeToHandoverMs: 0,
      avgEndToEndMs: Number(r.avgE2eMs ?? 0),
    })),
  ));
}

export async function getReturns(input: { auth: Auth; storeIdOverride?: string | undefined }) {
  const storeId = await resolveStoreId(input);
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const orderRows = await db
    .select({
      bucket: sql<string>`to_char(${orders.placedAt}, 'YYYY-MM-DD')`,
      ordersCount: count(),
    })
    .from(orders)
    .where(and(eq(orders.storeId, storeId), gte(orders.placedAt, since)))
    .groupBy(sql`to_char(${orders.placedAt}, 'YYYY-MM-DD')`)
    .orderBy(sql`to_char(${orders.placedAt}, 'YYYY-MM-DD')`);

  return ok(wrapReport(
    orderRows.map((r) => ({
      bucket: r.bucket,
      returnRateBp: 0,
      totalReturns: 0,
      topListing: '—',
      topReason: '—',
    })),
  ));
}

export async function getInventoryHealth(input: { auth: Auth; storeIdOverride?: string | undefined }) {
  const storeId = await resolveStoreId(input);

  // We need the store's legalEntityId to find listings
  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, storeId),
  });
  if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');

  // Return empty array — inventory health requires joining listings + inventory_variants
  // which is available through the retailer/inventory endpoint. Redirect there.
  return ok(wrapReport([]));
}

// ===== §21 Sales detailed (day|week|month) + breakdown (status|delivery_method|category) =====

export interface SalesDetailedInput {
  granularity: 'day' | 'week' | 'month';
  breakdown?: 'status' | 'delivery_method' | 'category' | undefined;
  since?: string | undefined;
  until?: string | undefined;
}

export async function getSalesDetailed(input: { auth: Auth; storeIdOverride?: string | undefined; query: SalesDetailedInput }) {
  const storeId = await resolveStoreId(input);
  const granularity = input.query.granularity;
  const fmt =
    granularity === 'day'
      ? 'YYYY-MM-DD'
      : granularity === 'week'
        ? 'IYYY-IW'
        : 'YYYY-MM';

  // Default window: 90 days for day, 26 weeks for week, 12 months for month.
  const lookbackMs =
    granularity === 'day'
      ? 90 * 24 * 60 * 60 * 1000
      : granularity === 'week'
        ? 26 * 7 * 24 * 60 * 60 * 1000
        : 365 * 24 * 60 * 60 * 1000;
  const since = input.query.since ? new Date(input.query.since) : new Date(Date.now() - lookbackMs);
  const until = input.query.until ? new Date(input.query.until) : new Date();

  const breakdown = input.query.breakdown;
  if (!breakdown) {
    const rows = await db
      .select({
        bucket: sql<string>`to_char(${orders.placedAt}, '${sql.raw(fmt)}')`,
        ordersCount: count(),
        grossPaise: sql<string>`COALESCE(SUM(${orders.grandTotalPaise}), 0)::bigint`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          gte(orders.placedAt, since),
          sql`${orders.placedAt} <= ${until}`,
        ),
      )
      .groupBy(sql`to_char(${orders.placedAt}, '${sql.raw(fmt)}')`)
      .orderBy(sql`to_char(${orders.placedAt}, '${sql.raw(fmt)}')`);
    return ok(wrapReport({
      granularity,
      breakdown: null,
      rows: rows.map((r) => ({
        bucket: r.bucket,
        ordersCount: Number(r.ordersCount),
        grossPaise: Number(r.grossPaise),
      })),
    }));
  }

  // Breakdown variants
  if (breakdown === 'status') {
    const rows = await db
      .select({
        bucket: sql<string>`to_char(${orders.placedAt}, '${sql.raw(fmt)}')`,
        key: orders.status,
        ordersCount: count(),
        grossPaise: sql<string>`COALESCE(SUM(${orders.grandTotalPaise}), 0)::bigint`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          gte(orders.placedAt, since),
          sql`${orders.placedAt} <= ${until}`,
        ),
      )
      .groupBy(sql`to_char(${orders.placedAt}, '${sql.raw(fmt)}')`, orders.status)
      .orderBy(sql`to_char(${orders.placedAt}, '${sql.raw(fmt)}')`);
    return ok(wrapReport({
      granularity,
      breakdown,
      rows: rows.map((r) => ({
        bucket: r.bucket,
        key: r.key,
        ordersCount: Number(r.ordersCount),
        grossPaise: Number(r.grossPaise),
      })),
    }));
  }

  if (breakdown === 'delivery_method') {
    const rows = await db
      .select({
        bucket: sql<string>`to_char(${orders.placedAt}, '${sql.raw(fmt)}')`,
        key: orders.deliveryMethod,
        ordersCount: count(),
        grossPaise: sql<string>`COALESCE(SUM(${orders.grandTotalPaise}), 0)::bigint`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          gte(orders.placedAt, since),
          sql`${orders.placedAt} <= ${until}`,
        ),
      )
      .groupBy(sql`to_char(${orders.placedAt}, '${sql.raw(fmt)}')`, orders.deliveryMethod)
      .orderBy(sql`to_char(${orders.placedAt}, '${sql.raw(fmt)}')`);
    return ok(wrapReport({
      granularity,
      breakdown,
      rows: rows.map((r) => ({
        bucket: r.bucket,
        key: r.key,
        ordersCount: Number(r.ordersCount),
        grossPaise: Number(r.grossPaise),
      })),
    }));
  }

  // category breakdown — join order_items
  const rows = await db
    .select({
      bucket: sql<string>`to_char(${orders.placedAt}, '${sql.raw(fmt)}')`,
      key: orderItems.categorySnap,
      itemsCount: sql<string>`SUM(${orderItems.qty})::bigint`,
      grossPaise: sql<string>`COALESCE(SUM(${orderItems.lineSubtotalPaise}), 0)::bigint`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(
      and(
        eq(orders.storeId, storeId),
        gte(orders.placedAt, since),
        sql`${orders.placedAt} <= ${until}`,
      ),
    )
    .groupBy(sql`to_char(${orders.placedAt}, '${sql.raw(fmt)}')`, orderItems.categorySnap)
    .orderBy(sql`to_char(${orders.placedAt}, '${sql.raw(fmt)}')`);
  return ok(wrapReport({
    granularity,
    breakdown,
    rows: rows.map((r) => ({
      bucket: r.bucket,
      key: r.key,
      itemsCount: Number(r.itemsCount),
      grossPaise: Number(r.grossPaise),
    })),
  }));
}

// ===== §21 Revenue summary — gross, refunds, commission, net =====

export async function getRevenueSummary(input: {
  auth: Auth;
  storeIdOverride?: string | undefined;
  query: { since?: string | undefined; until?: string | undefined };
}) {
  const storeId = await resolveStoreId(input);
  const since = input.query.since
    ? new Date(input.query.since)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const until = input.query.until ? new Date(input.query.until) : new Date();

  const ordersAgg = await db
    .select({
      ordersCount: count(),
      grossPaise: sql<string>`COALESCE(SUM(${orders.grandTotalPaise}), 0)::bigint`,
      commissionPaise: sql<string>`COALESCE(SUM((${orders.grandTotalPaise}::bigint * ${orders.platformFeeBpSnap})/10000), 0)::bigint`,
      tcsPaise: sql<string>`COALESCE(SUM((${orders.grandTotalPaise}::bigint * ${orders.tcsRateBpSnap})/10000), 0)::bigint`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.storeId, storeId),
        gte(orders.placedAt, since),
        sql`${orders.placedAt} <= ${until}`,
      ),
    )
    .then((r) => r[0]!);

  const refundsAgg = await db
    .select({
      refundsCount: count(),
      refundsPaise: sql<string>`COALESCE(SUM(${refunds.totalRefundPaise}), 0)::bigint`,
    })
    .from(refunds)
    .innerJoin(orders, eq(refunds.orderId, orders.id))
    .where(
      and(
        eq(orders.storeId, storeId),
        gte(orders.placedAt, since),
        sql`${orders.placedAt} <= ${until}`,
      ),
    )
    .then((r) => r[0]!);

  const gross = Number(ordersAgg.grossPaise);
  const commission = Number(ordersAgg.commissionPaise);
  const tcs = Number(ordersAgg.tcsPaise);
  const refundsTotal = Number(refundsAgg.refundsPaise);
  const netOfRefunds = gross - refundsTotal;
  const netOfCommission = gross - commission;
  const netMoneyIn = gross - refundsTotal - commission - tcs;

  return ok(wrapReport({
    windowStart: since.toISOString(),
    windowEnd: until.toISOString(),
    ordersCount: Number(ordersAgg.ordersCount),
    refundsCount: Number(refundsAgg.refundsCount),
    grossPaise: gross,
    refundsPaise: refundsTotal,
    commissionPaise: commission,
    tcsPaise: tcs,
    netOfRefundsPaise: netOfRefunds,
    netOfCommissionPaise: netOfCommission,
    netMoneyInPaise: netMoneyIn,
  }));
}

// ===== §21 Per-listing revenue =====

export async function getListingsRevenue(input: {
  auth: Auth;
  storeIdOverride?: string | undefined;
  query: { since?: string | undefined; until?: string | undefined; limit: number };
}) {
  const storeId = await resolveStoreId(input);
  const since = input.query.since
    ? new Date(input.query.since)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const until = input.query.until ? new Date(input.query.until) : new Date();

  const rows = await db
    .select({
      listingId: orderItems.listingId,
      listingName: sql<string>`MAX(${orderItems.listingNameSnap})`,
      itemsSold: sql<string>`COALESCE(SUM(${orderItems.qty}), 0)::bigint`,
      grossPaise: sql<string>`COALESCE(SUM(${orderItems.lineSubtotalPaise}), 0)::bigint`,
      ordersCount: sql<string>`COUNT(DISTINCT ${orderItems.orderId})::bigint`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(
      and(
        eq(orders.storeId, storeId),
        gte(orders.placedAt, since),
        sql`${orders.placedAt} <= ${until}`,
      ),
    )
    .groupBy(orderItems.listingId)
    .orderBy(sql`SUM(${orderItems.lineSubtotalPaise}) DESC`)
    .limit(input.query.limit);

  return ok(wrapReport(
    rows.map((r) => ({
      listingId: r.listingId,
      listingName: r.listingName,
      itemsSold: Number(r.itemsSold),
      ordersCount: Number(r.ordersCount),
      grossPaise: Number(r.grossPaise),
    })),
  ));
}

// ===== §21 Per-variant conversion — impressions → cart → delivered =====

export async function getVariantConversion(input: {
  auth: Auth;
  storeIdOverride?: string | undefined;
  query: { since?: string | undefined; until?: string | undefined; listingId?: string | undefined; limit: number };
}) {
  const storeId = await resolveStoreId(input);
  const since = input.query.since
    ? new Date(input.query.since)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const until = input.query.until ? new Date(input.query.until) : new Date();

  // Three independent aggregates per variant, then joined in memory.
  const baseVariantFilter = input.query.listingId
    ? and(eq(variants.listingId, input.query.listingId))
    : undefined;

  const variantRows = await db
    .select({
      id: variants.id,
      listingId: variants.listingId,
      listingName: productListings.name,
      label: variants.attributesLabel,
    })
    .from(variants)
    .innerJoin(productListings, eq(variants.listingId, productListings.id))
    .where(
      and(eq(productListings.storeId, storeId), baseVariantFilter ?? sql`true`),
    )
    .limit(input.query.limit);

  if (variantRows.length === 0) return ok(wrapReport([]));
  const ids = variantRows.map((v) => v.id);

  const [viewsRows, cartRows, deliveredRows] = await Promise.all([
    db
      .select({
        variantId: listingViews.variantId,
        views: sql<string>`COUNT(*)::bigint`,
      })
      .from(listingViews)
      .where(
        and(
          eq(listingViews.storeId, storeId),
          inArray(listingViews.variantId, ids),
          gte(listingViews.at, since),
          sql`${listingViews.at} <= ${until}`,
        ),
      )
      .groupBy(listingViews.variantId),
    db
      .select({
        variantId: cartEvents.variantId,
        adds: sql<string>`COUNT(*)::bigint`,
        totalQty: sql<string>`COALESCE(SUM(${cartEvents.qty}), 0)::bigint`,
      })
      .from(cartEvents)
      .where(
        and(
          eq(cartEvents.storeId, storeId),
          inArray(cartEvents.variantId, ids),
          gte(cartEvents.at, since),
          sql`${cartEvents.at} <= ${until}`,
        ),
      )
      .groupBy(cartEvents.variantId),
    db
      .select({
        variantId: orderItems.variantId,
        deliveredItems: sql<string>`COALESCE(SUM(CASE WHEN ${orders.deliveredAt} IS NOT NULL THEN ${orderItems.qty} ELSE 0 END), 0)::bigint`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .where(
        and(
          eq(orders.storeId, storeId),
          inArray(orderItems.variantId, ids),
          gte(orders.placedAt, since),
          sql`${orders.placedAt} <= ${until}`,
        ),
      )
      .groupBy(orderItems.variantId),
  ]);

  const viewsMap = new Map(viewsRows.map((r) => [r.variantId!, Number(r.views)]));
  const cartMap = new Map(cartRows.map((r) => [r.variantId, { adds: Number(r.adds), qty: Number(r.totalQty) }]));
  const deliveredMap = new Map(deliveredRows.map((r) => [r.variantId, Number(r.deliveredItems)]));

  return ok(wrapReport(
    variantRows.map((v) => {
      const views = viewsMap.get(v.id) ?? 0;
      const cart = cartMap.get(v.id) ?? { adds: 0, qty: 0 };
      const delivered = deliveredMap.get(v.id) ?? 0;
      return {
        variantId: v.id,
        listingId: v.listingId,
        listingName: v.listingName,
        label: v.label,
        views,
        cartAdds: cart.adds,
        cartQty: cart.qty,
        deliveredItems: delivered,
        viewToCartBp: views > 0 ? Math.round((cart.adds / views) * 10000) : 0,
        cartToDeliveredBp: cart.adds > 0 ? Math.round((delivered / cart.adds) * 10000) : 0,
        viewToDeliveredBp: views > 0 ? Math.round((delivered / views) * 10000) : 0,
      };
    }),
  ));
}

// ===== §21 Top-returned listings + reason breakdown =====

export async function getReturnsTopListings(input: {
  auth: Auth;
  storeIdOverride?: string | undefined;
  query: { since?: string | undefined; until?: string | undefined; limit: number };
}) {
  const storeId = await resolveStoreId(input);
  const since = input.query.since
    ? new Date(input.query.since)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const until = input.query.until ? new Date(input.query.until) : new Date();

  const topRows = await db
    .select({
      listingId: orderItems.listingId,
      listingName: sql<string>`MAX(${orderItems.listingNameSnap})`,
      returnsCount: sql<string>`COUNT(${returnsTable.id})::bigint`,
      itemsSold: sql<string>`COALESCE(SUM(${orderItems.qty}), 0)::bigint`,
    })
    .from(returnsTable)
    .innerJoin(orderItems, eq(returnsTable.orderItemId, orderItems.id))
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(
      and(
        eq(orders.storeId, storeId),
        gte(returnsTable.openedAt, since),
        sql`${returnsTable.openedAt} <= ${until}`,
      ),
    )
    .groupBy(orderItems.listingId)
    .orderBy(sql`COUNT(${returnsTable.id}) DESC`)
    .limit(input.query.limit);

  if (topRows.length === 0) return ok(wrapReport([]));
  const listingIds = topRows.map((r) => r.listingId);

  const reasonRows = await db
    .select({
      listingId: orderItems.listingId,
      reasonCategory: returnsTable.reasonCategory,
      count: sql<string>`COUNT(*)::bigint`,
    })
    .from(returnsTable)
    .innerJoin(orderItems, eq(returnsTable.orderItemId, orderItems.id))
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(
      and(
        eq(orders.storeId, storeId),
        inArray(orderItems.listingId, listingIds),
        gte(returnsTable.openedAt, since),
        sql`${returnsTable.openedAt} <= ${until}`,
      ),
    )
    .groupBy(orderItems.listingId, returnsTable.reasonCategory);

  const reasonMap = new Map<string, Record<string, number>>();
  for (const r of reasonRows) {
    const key = r.reasonCategory ?? 'unspecified';
    const cur = reasonMap.get(r.listingId) ?? {};
    cur[key] = Number(r.count);
    reasonMap.set(r.listingId, cur);
  }

  return ok(wrapReport(
    topRows.map((r) => ({
      listingId: r.listingId,
      listingName: r.listingName,
      returnsCount: Number(r.returnsCount),
      itemsSold: Number(r.itemsSold),
      returnRateBp:
        Number(r.itemsSold) > 0
          ? Math.round((Number(r.returnsCount) / Number(r.itemsSold)) * 10000)
          : 0,
      reasonBreakdown: reasonMap.get(r.listingId) ?? {},
    })),
  ));
}

// ===== §21 Best-sellers + dead-stock =====

export async function getBestSellers(input: {
  auth: Auth;
  storeIdOverride?: string | undefined;
  query: { since?: string | undefined; until?: string | undefined; limit: number };
}) {
  const storeId = await resolveStoreId(input);
  const since = input.query.since
    ? new Date(input.query.since)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const until = input.query.until ? new Date(input.query.until) : new Date();

  const rows = await db
    .select({
      listingId: orderItems.listingId,
      listingName: sql<string>`MAX(${orderItems.listingNameSnap})`,
      unitsSold: sql<string>`COALESCE(SUM(${orderItems.qty}), 0)::bigint`,
      grossPaise: sql<string>`COALESCE(SUM(${orderItems.lineSubtotalPaise}), 0)::bigint`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(
      and(
        eq(orders.storeId, storeId),
        gte(orders.placedAt, since),
        sql`${orders.placedAt} <= ${until}`,
      ),
    )
    .groupBy(orderItems.listingId)
    .orderBy(sql`SUM(${orderItems.qty}) DESC`)
    .limit(input.query.limit);

  return ok(wrapReport(
    rows.map((r) => ({
      listingId: r.listingId,
      listingName: r.listingName,
      unitsSold: Number(r.unitsSold),
      grossPaise: Number(r.grossPaise),
    })),
  ));
}

export async function getDeadStock(input: {
  auth: Auth;
  storeIdOverride?: string | undefined;
  query: { daysWithoutSale: number; limit: number };
}) {
  const storeId = await resolveStoreId(input);
  const cutoff = new Date(Date.now() - input.query.daysWithoutSale * 24 * 60 * 60 * 1000);

  // Per-variant dead stock: each in-stock SKU is judged on its own. A variant is
  // "dead" when it has stock > 0 and no order was *placed* for that exact variant
  // within the window (last placed order older than cutoff, or never sold). Listing
  // not retired. Placed (not delivered) keeps this consistent with the best-sellers
  // / conversion reports, so a just-placed order immediately revives its variant.
  const rows = await db
    .select({
      variantId: variants.id,
      listingId: productListings.id,
      listingName: productListings.name,
      label: variants.attributesLabel,
      sku: variants.sku,
      stock: variants.stock,
      lastSoldAt: sql<Date | null>`MAX(${orders.placedAt})`,
    })
    .from(variants)
    .innerJoin(productListings, eq(variants.listingId, productListings.id))
    .leftJoin(orderItems, eq(orderItems.variantId, variants.id))
    .leftJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        eq(productListings.storeId, storeId),
        sql`${productListings.status} <> 'retired'`,
        sql`${variants.stock} > 0`,
      ),
    )
    .groupBy(variants.id, productListings.id, productListings.name, variants.attributesLabel, variants.sku, variants.stock)
    .having(
      sql`MAX(${orders.placedAt}) IS NULL OR MAX(${orders.placedAt}) < ${cutoff}`,
    )
    .orderBy(sql`${variants.stock} DESC`)
    .limit(input.query.limit);

  return ok(wrapReport(
    rows.map((r) => ({
      variantId: r.variantId,
      listingId: r.listingId,
      listingName: r.listingName,
      label: r.label,
      sku: r.sku,
      totalStock: Number(r.stock),
      lastSoldAt: r.lastSoldAt ? new Date(r.lastSoldAt).toISOString() : null,
    })),
  ));
}

// ===== §21 Per-cycle payout breakdown =====

export async function getPayoutCycles(input: {
  auth: Auth;
  storeIdOverride?: string | undefined;
  query: { limit: number };
}) {
  const storeId = await resolveStoreId(input);
  const rows = await db
    .select()
    .from(payouts)
    .where(eq(payouts.storeId, storeId))
    .orderBy(desc(payouts.cycleStart))
    .limit(input.query.limit);

  return ok(wrapReport(
    rows.map((p) => {
      const gross = Number(p.grossPaise);
      const commission = Number(p.commissionPaise);
      const refundsHeld = Number(p.refundsHeldPaise);
      const adjustments = Number(p.adjustmentsPaise);
      const disputeHold = Number(p.disputeHoldPaise);
      const net = Number(p.netPaise);
      return {
        id: p.id,
        status: p.status,
        cycleStart: p.cycleStart.toISOString(),
        cycleEnd: p.cycleEnd.toISOString(),
        grossPaise: gross,
        commissionPaise: commission,
        refundsHeldPaise: refundsHeld,
        adjustmentsPaise: adjustments,
        disputeHoldPaise: disputeHold,
        netPaise: net,
        breakdown: {
          gross,
          minus_commission: -commission,
          minus_refundsHeld: -refundsHeld,
          minus_disputeHold: -disputeHold,
          plus_adjustments: adjustments,
          net,
        },
      };
    }),
  ));
}

// ===== §21 Compliance trailing 30d with warning flags =====
//
// Floors mirror admin defaults (admin/reports/reports.controller.ts):
//   acceptance ≥ 80% (8000 bp), fulfilment ≥ 85% (8500 bp).
// Warning thresholds set 5pp tighter so retailer sees yellow before admin red:
//   warn at acceptance < 85% (8500), fulfilment < 90% (9000).
// Dispute/return rate ceilings: warn at 5% (500), breach at 10% (1000).

const ACCEPTANCE_FLOOR_BP = 8000;
const ACCEPTANCE_WARN_BP = 8500;
const FULFILMENT_FLOOR_BP = 8500;
const FULFILMENT_WARN_BP = 9000;
const DISPUTE_RATE_CEIL_BP = 1000;
const DISPUTE_RATE_WARN_BP = 500;
const RETURN_RATE_CEIL_BP = 1500;
const RETURN_RATE_WARN_BP = 800;

export async function getCompliance(input: { auth: Auth; storeIdOverride?: string | undefined }) {
  const storeId = await resolveStoreId(input);
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const ord = await db
    .select({
      total: count(),
      accepted: sql<number>`COUNT(${orders.acceptedAt})::int`,
      delivered: sql<number>`COUNT(${orders.deliveredAt})::int`,
      avgAcceptMs: sql<number>`COALESCE(AVG(EXTRACT(EPOCH FROM (${orders.acceptedAt} - ${orders.placedAt})) * 1000)::int, 0)`,
      avgFulfilMs: sql<number>`COALESCE(AVG(EXTRACT(EPOCH FROM (${orders.deliveredAt} - ${orders.placedAt})) * 1000)::int, 0)`,
      itemsTotal: sql<string>`COALESCE((SELECT SUM(${orderItems.qty})::bigint FROM ${orderItems} oi WHERE oi.order_id IN (SELECT id FROM ${orders} o WHERE o.store_id=${storeId} AND o.placed_at>=${since})), 0)`,
    })
    .from(orders)
    .where(and(eq(orders.storeId, storeId), gte(orders.placedAt, since)))
    .then((r) => r[0]!);

  const disputeCount = await db
    .select({ c: sql<number>`COUNT(${customerIssues.id})::int` })
    .from(customerIssues)
    .innerJoin(orders, eq(customerIssues.orderId, orders.id))
    .where(
      and(
        eq(orders.storeId, storeId),
        eq(customerIssues.kind, 'dispute'),
        gte(orders.placedAt, since),
      ),
    )
    .then((r) => r[0]!.c);

  const returnCount = await db
    .select({ c: sql<number>`COUNT(${returnsTable.id})::int` })
    .from(returnsTable)
    .innerJoin(orderItems, eq(returnsTable.orderItemId, orderItems.id))
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(
      and(eq(orders.storeId, storeId), gte(orders.placedAt, since)),
    )
    .then((r) => r[0]!.c);

  const total = ord.total;
  const itemsTotal = Number(ord.itemsTotal);

  const acceptanceRateBp = total > 0 ? Math.round((ord.accepted / total) * 10000) : 0;
  const fulfilmentRateBp = total > 0 ? Math.round((ord.delivered / total) * 10000) : 0;
  const disputeRateBp = total > 0 ? Math.round((disputeCount / total) * 10000) : 0;
  const returnRateBp = itemsTotal > 0 ? Math.round((returnCount / itemsTotal) * 10000) : 0;

  const verdict = (
    value: number,
    floorBp: number,
    warnBp: number,
    direction: 'high_is_good' | 'low_is_good',
  ): 'ok' | 'warning' | 'breach' => {
    if (total === 0) return 'ok';
    if (direction === 'high_is_good') {
      if (value < floorBp) return 'breach';
      if (value < warnBp) return 'warning';
      return 'ok';
    }
    if (value > floorBp) return 'breach';
    if (value > warnBp) return 'warning';
    return 'ok';
  };

  return ok(wrapReport({
    windowStart: since.toISOString(),
    windowEnd: new Date().toISOString(),
    ordersTotal: total,
    itemsTotal,
    metrics: {
      acceptance: {
        valueBp: acceptanceRateBp,
        floorBp: ACCEPTANCE_FLOOR_BP,
        warnBp: ACCEPTANCE_WARN_BP,
        verdict: verdict(acceptanceRateBp, ACCEPTANCE_FLOOR_BP, ACCEPTANCE_WARN_BP, 'high_is_good'),
        avgAcceptMs: Number(ord.avgAcceptMs),
      },
      fulfilment: {
        valueBp: fulfilmentRateBp,
        floorBp: FULFILMENT_FLOOR_BP,
        warnBp: FULFILMENT_WARN_BP,
        verdict: verdict(fulfilmentRateBp, FULFILMENT_FLOOR_BP, FULFILMENT_WARN_BP, 'high_is_good'),
        avgEndToEndMs: Number(ord.avgFulfilMs),
      },
      disputeRate: {
        valueBp: disputeRateBp,
        ceilBp: DISPUTE_RATE_CEIL_BP,
        warnBp: DISPUTE_RATE_WARN_BP,
        verdict: verdict(disputeRateBp, DISPUTE_RATE_CEIL_BP, DISPUTE_RATE_WARN_BP, 'low_is_good'),
        count: disputeCount,
      },
      returnRate: {
        valueBp: returnRateBp,
        ceilBp: RETURN_RATE_CEIL_BP,
        warnBp: RETURN_RATE_WARN_BP,
        verdict: verdict(returnRateBp, RETURN_RATE_CEIL_BP, RETURN_RATE_WARN_BP, 'low_is_good'),
        count: returnCount,
      },
    },
  }));
}

export async function getPlatformPromoCommission(input: { auth: Auth; storeIdOverride?: string | undefined }) {
  const storeId = await resolveStoreId(input);

  const platformPromoRows = await db.query.promotions.findMany({
    where: and(eq(promotions.issuerType, 'admin'), isNull(promotions.storeId)),
    columns: { id: true, name: true, mechanism: true, discountType: true },
  });
  if (platformPromoRows.length === 0) return ok(wrapReport([]));
  const promoIds = platformPromoRows.map((p) => p.id);
  const promoMeta = new Map(platformPromoRows.map((p) => [p.id, p]));

  // Per-promo aggregate, scoped to orders that belong to this store.
  const rows = await db
    .select({
      promotionId: promotionRedemptions.promotionId,
      orderCount: sql<number>`COUNT(DISTINCT ${promotionRedemptions.orderId})::int`,
      totalDiscountPaise: sum(promotionRedemptions.amountAppliedPaise),
      gmvInfluencedPaise: sql<number>`COALESCE(SUM(${orders.grandTotalPaise}), 0)::bigint`,
      firstRedeemedAt: sql<string>`MIN(${promotionRedemptions.at})`,
      lastRedeemedAt: sql<string>`MAX(${promotionRedemptions.at})`,
    })
    .from(promotionRedemptions)
    .innerJoin(orders, eq(orders.id, promotionRedemptions.orderId))
    .where(
      and(
        inArray(promotionRedemptions.promotionId, promoIds),
        eq(orders.storeId, storeId),
      ),
    )
    .groupBy(promotionRedemptions.promotionId);

  return ok(wrapReport(
    rows.map((r) => {
      const meta = promoMeta.get(r.promotionId);
      return {
        promotionId: r.promotionId,
        promotionName: meta?.name ?? r.promotionId,
        mechanism: meta?.mechanism ?? null,
        discountType: meta?.discountType ?? null,
        orderCount: Number(r.orderCount ?? 0),
        totalDiscountPaise: Number(r.totalDiscountPaise ?? 0),
        gmvInfluencedPaise: Number(r.gmvInfluencedPaise ?? 0),
        firstRedeemedAt: r.firstRedeemedAt,
        lastRedeemedAt: r.lastRedeemedAt,
      };
    }),
  ));
}
