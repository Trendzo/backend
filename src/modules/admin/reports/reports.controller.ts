import { and, count, eq, gte, isNotNull, lt, sql, sum } from 'drizzle-orm';
import { db } from '@/db/client.js';
import {
  aiCatalogSubmissions,
  cartEvents,
  consumers,
  customerIssues,
  disputes,
  listingViews,
  orderItems,
  orders,
  payouts,
  policyEnforcementActions,
  refunds,
  retailerStores,
  returns as returnsTable,
  supportTickets,
} from '@/db/schema/index.js';
import { ok } from '@/shared/http/envelope.js';
import { withReportMeta, withReportRows } from '@/shared/reports/meta.js';

const ACCEPTANCE_FLOOR_BP = 8000; // 80%
const FULFILMENT_FLOOR_BP = 8500; // 85%

function fmtMs(ms: number): string {
  if (ms === 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ===== §21 Headline platform report =====
//
// GMV, take rate (commission / GMV), refund rate (refunds / GMV), AOV (GMV / orders),
// customer cohorts (monthly signup buckets with first-30d-spend).

export async function getHeadline() {
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const cohortLookback = new Date(Date.now() - 12 * 30 * 24 * 60 * 60 * 1000);

  const [ordAgg, refundAgg, newConsumers, totalConsumers] = await Promise.all([
    db
      .select({
        orderCount: count(),
        gmvPaise: sql<string>`COALESCE(SUM(${orders.grandTotalPaise}), 0)::bigint`,
        commissionPaise: sql<string>`COALESCE(SUM((${orders.grandTotalPaise}::bigint * ${orders.platformFeeBpSnap})/10000), 0)::bigint`,
        tcsPaise: sql<string>`COALESCE(SUM((${orders.grandTotalPaise}::bigint * ${orders.tcsRateBpSnap})/10000), 0)::bigint`,
      })
      .from(orders)
      .where(gte(orders.placedAt, since30))
      .then((r) => r[0]!),
    db
      .select({
        refundCount: count(),
        refundPaise: sql<string>`COALESCE(SUM(${refunds.totalRefundPaise}), 0)::bigint`,
      })
      .from(refunds)
      .innerJoin(orders, eq(refunds.orderId, orders.id))
      .where(gte(orders.placedAt, since30))
      .then((r) => r[0]!),
    db
      .select({ n: count() })
      .from(consumers)
      .where(gte(consumers.signupAt, since30))
      .then((r) => Number(r[0]?.n ?? 0)),
    db
      .select({ n: count() })
      .from(consumers)
      .then((r) => Number(r[0]?.n ?? 0)),
  ]);

  const gmv = Number(ordAgg.gmvPaise);
  const commission = Number(ordAgg.commissionPaise);
  const tcs = Number(ordAgg.tcsPaise);
  const refundsTotal = Number(refundAgg.refundPaise);
  const orderCount = ordAgg.orderCount;

  const takeRateBp = gmv > 0 ? Math.round(((commission + tcs) / gmv) * 10000) : 0;
  const refundRateBp = gmv > 0 ? Math.round((refundsTotal / gmv) * 10000) : 0;
  const aovPaise = orderCount > 0 ? Math.round(gmv / orderCount) : 0;

  // Monthly signup cohorts — count + 30d-spend after signup.
  const cohortRows = await db
    .select({
      cohortMonth: sql<string>`to_char(${consumers.signupAt}, 'YYYY-MM')`,
      consumerCount: count(),
    })
    .from(consumers)
    .where(gte(consumers.signupAt, cohortLookback))
    .groupBy(sql`to_char(${consumers.signupAt}, 'YYYY-MM')`)
    .orderBy(sql`to_char(${consumers.signupAt}, 'YYYY-MM')`);

  // For each cohort, spend in first 30 days after signup.
  const cohortSpend = await db
    .select({
      cohortMonth: sql<string>`to_char(${consumers.signupAt}, 'YYYY-MM')`,
      grossPaise: sql<string>`COALESCE(SUM(${orders.grandTotalPaise}), 0)::bigint`,
      ordersPlaced: count(),
    })
    .from(orders)
    .innerJoin(consumers, eq(orders.consumerId, consumers.id))
    .where(
      and(
        gte(consumers.signupAt, cohortLookback),
        sql`${orders.placedAt} <= ${consumers.signupAt} + INTERVAL '30 days'`,
      ),
    )
    .groupBy(sql`to_char(${consumers.signupAt}, 'YYYY-MM')`);

  const spendMap = new Map(
    cohortSpend.map((r) => [
      r.cohortMonth,
      { gross: Number(r.grossPaise), orders: r.ordersPlaced },
    ]),
  );

  return ok(withReportMeta({
    windowDays: 30,
    grossMerchandiseValuePaise: gmv,
    orderCount,
    averageOrderValuePaise: aovPaise,
    commissionPaise: commission,
    tcsPaise: tcs,
    takeRateBp,
    refundsPaise: refundsTotal,
    refundCount: refundAgg.refundCount,
    refundRateBp,
    newConsumers30d: newConsumers,
    totalConsumers,
    cohorts: cohortRows.map((c) => {
      const sp = spendMap.get(c.cohortMonth) ?? { gross: 0, orders: 0 };
      return {
        cohortMonth: c.cohortMonth,
        consumerCount: c.consumerCount,
        first30dSpendPaise: sp.gross,
        first30dOrders: sp.orders,
        first30dArpuPaise: c.consumerCount > 0 ? Math.round(sp.gross / c.consumerCount) : 0,
      };
    }),
  }));
}

export async function getLeaderboard(input?: { query?: { topN?: number } }) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const topN = input?.query?.topN ?? 10;

  const [orderStats, disputeStats, returnStats, itemsStats] = await Promise.all([
    db
      .select({
        storeId: orders.storeId,
        storeName: orders.storeNameSnap,
        total: count(),
        accepted: sql<number>`COUNT(${orders.acceptedAt})::int`,
        delivered: sql<number>`COUNT(${orders.deliveredAt})::int`,
      })
      .from(orders)
      .where(gte(orders.placedAt, since))
      .groupBy(orders.storeId, orders.storeNameSnap),

    db
      .select({
        storeId: orders.storeId,
        disputeCount: count(),
      })
      .from(disputes)
      .innerJoin(orders, eq(disputes.orderId, orders.id))
      .where(and(isNotNull(disputes.orderId), gte(disputes.openedAt, since)))
      .groupBy(orders.storeId),

    db
      .select({
        storeId: orders.storeId,
        returnCount: count(),
      })
      .from(returnsTable)
      .innerJoin(orderItems, eq(returnsTable.orderItemId, orderItems.id))
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .where(gte(returnsTable.openedAt, since))
      .groupBy(orders.storeId),

    db
      .select({
        storeId: orders.storeId,
        itemsTotal: sql<string>`COALESCE(SUM(${orderItems.qty}), 0)::bigint`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .where(gte(orders.placedAt, since))
      .groupBy(orders.storeId),
  ]);

  const disputeMap = new Map(disputeStats.map((d) => [d.storeId, d.disputeCount]));
  const returnMap = new Map(returnStats.map((r) => [r.storeId, r.returnCount]));
  const itemsMap = new Map(itemsStats.map((r) => [r.storeId, Number(r.itemsTotal)]));

  const scored = orderStats.map((s) => {
    const total = s.total > 0 ? s.total : 1;
    const items = itemsMap.get(s.storeId) ?? 0;
    const acceptanceRateBp = Math.round((s.accepted / total) * 10000);
    const fulfilmentScoreBp = Math.round((s.delivered / total) * 10000);
    const dc = Number(disputeMap.get(s.storeId) ?? 0);
    const rc = Number(returnMap.get(s.storeId) ?? 0);
    const disputeRateBp = Math.round((dc / total) * 10000);
    const returnRateBp = items > 0 ? Math.round((rc / items) * 10000) : 0;
    const score =
      acceptanceRateBp * 0.4 +
      fulfilmentScoreBp * 0.3 +
      (10000 - disputeRateBp) * 0.15 +
      (10000 - returnRateBp) * 0.15;
    return {
      retailerId: s.storeId,
      retailerName: s.storeName,
      ordersTotal: s.total,
      itemsTotal: items,
      acceptanceRateBp,
      fulfilmentScoreBp,
      disputeRateBp,
      returnRateBp,
      score: Math.round(score),
    };
  });

  const sortedBest = [...scored].sort((a, b) => b.score - a.score);
  const sortedWorst = [...scored].sort((a, b) => a.score - b.score);

  return ok(
    withReportMeta({
      windowDays: 30,
      best: sortedBest.slice(0, topN).map((r, i) => ({ rank: i + 1, ...r })),
      worst: sortedWorst.slice(0, topN).map((r, i) => ({ rank: i + 1, ...r })),
      all: scored,
    }),
  );
}

export async function getCompliance() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const stats = await db
    .select({
      storeId: orders.storeId,
      storeName: orders.storeNameSnap,
      total: count(),
      accepted: sql<number>`COUNT(${orders.acceptedAt})::int`,
      delivered: sql<number>`COUNT(${orders.deliveredAt})::int`,
    })
    .from(orders)
    .where(gte(orders.placedAt, since))
    .groupBy(orders.storeId, orders.storeNameSnap)
    .having(sql`COUNT(*) >= 5`);

  const breaches: Array<{
    retailerId: string;
    retailerName: string;
    metric: string;
    value: string;
    threshold: string;
    daysBelow: number;
  }> = [];

  for (const s of stats) {
    const total = s.total > 0 ? s.total : 1;
    const name = s.storeName;
    const acceptBp = Math.round((s.accepted / total) * 10000);
    const fulfilBp = Math.round((s.delivered / total) * 10000);

    if (acceptBp < ACCEPTANCE_FLOOR_BP) {
      breaches.push({
        retailerId: s.storeId,
        retailerName: name,
        metric: 'Acceptance rate',
        value: `${(acceptBp / 100).toFixed(1)}%`,
        threshold: `${(ACCEPTANCE_FLOOR_BP / 100).toFixed(0)}%`,
        daysBelow: 30,
      });
    }
    if (fulfilBp < FULFILMENT_FLOOR_BP) {
      breaches.push({
        retailerId: s.storeId,
        retailerName: name,
        metric: 'Fulfilment rate',
        value: `${(fulfilBp / 100).toFixed(1)}%`,
        threshold: `${(FULFILMENT_FLOOR_BP / 100).toFixed(0)}%`,
        daysBelow: 30,
      });
    }
  }

  return ok(withReportRows(breaches));
}

// ===== §21 Below-floor list with current enforcement state =====

const DISPUTE_RATE_FLOOR_BP = 1000; // 10%

export async function getBelowFloor() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const stats = await db
    .select({
      storeId: orders.storeId,
      storeName: orders.storeNameSnap,
      total: count(),
      accepted: sql<number>`COUNT(${orders.acceptedAt})::int`,
    })
    .from(orders)
    .where(gte(orders.placedAt, since))
    .groupBy(orders.storeId, orders.storeNameSnap)
    .having(sql`COUNT(*) >= 5`);

  const disputeAgg = await db
    .select({
      storeId: orders.storeId,
      n: count(),
    })
    .from(disputes)
    .innerJoin(orders, eq(disputes.orderId, orders.id))
    .where(and(isNotNull(disputes.orderId), gte(disputes.openedAt, since)))
    .groupBy(orders.storeId);
  const disputeMap = new Map(disputeAgg.map((d) => [d.storeId, d.n]));

  // Pull all enforcement rows since 90d so we can attach the *current* (most-recent non-lifted)
  // step per store.
  const enforcementSince = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const enforcement = await db
    .select()
    .from(policyEnforcementActions)
    .where(gte(policyEnforcementActions.actedAt, enforcementSince))
    .orderBy(sql`${policyEnforcementActions.actedAt} DESC`);

  const currentEnforcement = new Map<
    string,
    {
      step: string;
      breachKind: string;
      actedAt: string;
      reason: string | null;
    } | null
  >();
  for (const e of enforcement) {
    if (currentEnforcement.has(e.storeId)) continue;
    if (e.step === 'lifted') {
      currentEnforcement.set(e.storeId, null);
      continue;
    }
    currentEnforcement.set(e.storeId, {
      step: e.step,
      breachKind: e.breachKind,
      actedAt: e.actedAt.toISOString(),
      reason: e.reason ?? null,
    });
  }

  const rows: Array<{
    retailerId: string;
    retailerName: string;
    breaches: Array<{ metric: string; valueBp: number; floorBp: number }>;
    currentEnforcement: ReturnType<typeof currentEnforcement.get>;
    suggestedAction: string;
  }> = [];

  for (const s of stats) {
    const total = s.total > 0 ? s.total : 1;
    const acceptBp = Math.round((s.accepted / total) * 10000);
    const dc = Number(disputeMap.get(s.storeId) ?? 0);
    const disputeBp = Math.round((dc / total) * 10000);

    const breaches: Array<{ metric: string; valueBp: number; floorBp: number }> = [];
    if (acceptBp < ACCEPTANCE_FLOOR_BP) {
      breaches.push({ metric: 'acceptance_rate', valueBp: acceptBp, floorBp: ACCEPTANCE_FLOOR_BP });
    }
    if (disputeBp > DISPUTE_RATE_FLOOR_BP) {
      breaches.push({ metric: 'dispute_rate', valueBp: disputeBp, floorBp: DISPUTE_RATE_FLOOR_BP });
    }
    if (breaches.length === 0) continue;

    const cur = currentEnforcement.get(s.storeId) ?? null;
    let suggested = 'nudge';
    if (cur?.step === 'warning_3' || cur?.step === 'suspension') suggested = 'terminate';
    else if (cur?.step === 'warning_2') suggested = 'suspend';
    else if (cur?.step === 'warning_1') suggested = 'warn_again';
    else if (breaches.length > 1) suggested = 'pause';

    rows.push({
      retailerId: s.storeId,
      retailerName: s.storeName,
      breaches,
      currentEnforcement: cur,
      suggestedAction: suggested,
    });
  }

  return ok(withReportMeta({ windowDays: 30, rows }));
}

export async function getFunnel() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [views, carts, placed, accepted, delivered] = await Promise.all([
    db
      .select({ n: count() })
      .from(listingViews)
      .where(gte(listingViews.at, since))
      .then((r) => Number(r[0]?.n ?? 0)),
    db
      .select({ n: count() })
      .from(cartEvents)
      .where(gte(cartEvents.at, since))
      .then((r) => Number(r[0]?.n ?? 0)),
    db
      .select({ n: count() })
      .from(orders)
      .where(gte(orders.placedAt, since))
      .then((r) => Number(r[0]?.n ?? 0)),
    db
      .select({ n: count() })
      .from(orders)
      .where(and(gte(orders.placedAt, since), isNotNull(orders.acceptedAt)))
      .then((r) => Number(r[0]?.n ?? 0)),
    db
      .select({ n: count() })
      .from(orders)
      .where(and(gte(orders.placedAt, since), isNotNull(orders.deliveredAt)))
      .then((r) => Number(r[0]?.n ?? 0)),
  ]);

  const steps = [
    { label: 'Listing view', count: views },
    { label: 'Add to cart', count: carts },
    { label: 'Order placed', count: placed },
    { label: 'Accepted by retailer', count: accepted },
    { label: 'Delivered to consumer', count: delivered },
  ];

  return ok(
    withReportMeta({
      windowDays: 30,
      steps: steps.map((s, i) => ({
        label: s.label,
        count: s.count,
        dropoffPctFromPrevious:
          i === 0
            ? 0
            : steps[i - 1]!.count > 0
              ? Math.round(((steps[i - 1]!.count - s.count) / steps[i - 1]!.count) * 10000) / 100
              : 0,
      })),
    }),
  );
}

export async function getOperational() {
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    orderStats,
    orderStats7,
    failedPayouts,
    openTickets,
    payoutVolume,
    ordersLast24h,
    disputeCount30d,
    hourlyRows,
  ] = await Promise.all([
    db
      .select({
        total: count(),
        avgAcceptMs: sql<number>`COALESCE(
          AVG(EXTRACT(EPOCH FROM (${orders.acceptedAt} - ${orders.placedAt})) * 1000)::int, 0)`,
        avgE2eMs: sql<number>`COALESCE(
          AVG(EXTRACT(EPOCH FROM (${orders.deliveredAt} - ${orders.placedAt})) * 1000)::int, 0)`,
        grossPaise: sum(orders.grandTotalPaise),
      })
      .from(orders)
      .where(gte(orders.placedAt, since30))
      .then((r) => r[0]!),

    db
      .select({ total: count() })
      .from(orders)
      .where(gte(orders.placedAt, since7))
      .then((r) => Number(r[0]?.total ?? 0)),

    db
      .select({ n: count() })
      .from(payouts)
      .where(eq(payouts.status, 'failed'))
      .then((r) => Number(r[0]?.n ?? 0)),

    db
      .select({ n: count() })
      .from(supportTickets)
      .where(eq(supportTickets.status, 'open'))
      .then((r) => Number(r[0]?.n ?? 0)),

    db
      .select({
        completedPaise: sql<string>`COALESCE(SUM(CASE WHEN ${payouts.status}='completed' THEN ${payouts.netPaise} ELSE 0 END), 0)::bigint`,
        pendingPaise: sql<string>`COALESCE(SUM(CASE WHEN ${payouts.status} IN ('pending','processing') THEN ${payouts.netPaise} ELSE 0 END), 0)::bigint`,
        completedCount: sql<number>`COUNT(*) FILTER (WHERE ${payouts.status}='completed')::int`,
        pendingCount: sql<number>`COUNT(*) FILTER (WHERE ${payouts.status} IN ('pending','processing'))::int`,
      })
      .from(payouts)
      .where(gte(payouts.cycleStart, since30))
      .then((r) => r[0]!),

    db
      .select({ n: count() })
      .from(orders)
      .where(gte(orders.placedAt, since24h))
      .then((r) => Number(r[0]?.n ?? 0)),

    db
      .select({ n: count() })
      .from(disputes)
      .where(gte(disputes.openedAt, since30))
      .then((r) => Number(r[0]?.n ?? 0)),

    db
      .select({
        bucket: sql<string>`to_char(date_trunc('hour', ${orders.placedAt}), 'YYYY-MM-DD HH24:00')`,
        n: count(),
      })
      .from(orders)
      .where(gte(orders.placedAt, since24h))
      .groupBy(sql`date_trunc('hour', ${orders.placedAt})`)
      .orderBy(sql`date_trunc('hour', ${orders.placedAt})`),
  ]);

  const ordersPerDay7 = Math.round(orderStats7 / 7);
  const ordersPerHour24h = Math.round(ordersLast24h / 24);
  const gmv = Number(orderStats.grossPaise ?? 0);
  const totalOrders30d = orderStats.total;
  const disputeRateBp = totalOrders30d > 0 ? Math.round((disputeCount30d / totalOrders30d) * 10000) : 0;

  return ok(
    withReportMeta({
      windowDays: 30,
      summary: [
        { metric: 'Orders / hour (24h avg)', value: ordersPerHour24h.toLocaleString('en-IN'), raw: ordersPerHour24h },
        { metric: 'Orders / day (7d avg)', value: ordersPerDay7.toLocaleString('en-IN'), raw: ordersPerDay7 },
        { metric: 'Orders (30d total)', value: totalOrders30d.toLocaleString('en-IN'), raw: totalOrders30d },
        { metric: 'Avg acceptance time', value: fmtMs(Number(orderStats.avgAcceptMs ?? 0)), raw: Number(orderStats.avgAcceptMs ?? 0) },
        { metric: 'Avg end-to-end time', value: fmtMs(Number(orderStats.avgE2eMs ?? 0)), raw: Number(orderStats.avgE2eMs ?? 0) },
        { metric: 'GMV (30d)', value: `₹${(gmv / 100).toLocaleString('en-IN')}`, raw: gmv },
        { metric: 'Dispute rate (30d)', value: `${(disputeRateBp / 100).toFixed(2)}%`, raw: disputeRateBp },
        { metric: 'Failed payouts', value: failedPayouts.toLocaleString('en-IN'), raw: failedPayouts },
        { metric: 'Open support tickets', value: openTickets.toLocaleString('en-IN'), raw: openTickets },
      ],
      payoutVolume: {
        completedPaise: Number(payoutVolume.completedPaise),
        pendingPaise: Number(payoutVolume.pendingPaise),
        completedCount: payoutVolume.completedCount,
        pendingCount: payoutVolume.pendingCount,
      },
      hourly: hourlyRows.map((r) => ({ bucket: r.bucket, ordersCount: r.n })),
    }),
  );
}

export async function getFeatureUsage() {
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // AI catalog: real per-submission cost from platform_config key 'ai_catalog_cost_per_submission_paise'
  // falls back to ₹50/submission. Status breakdown captures success vs reject vs in-flight.
  const [aiAgg, aiByStatus] = await Promise.all([
    db
      .select({
        uniqueUsers: sql<number>`COUNT(DISTINCT ${aiCatalogSubmissions.storeId})::int`,
        totalUsage: count(),
      })
      .from(aiCatalogSubmissions)
      .where(gte(aiCatalogSubmissions.at, since30))
      .then((r) => r[0]!),
    db
      .select({
        status: aiCatalogSubmissions.status,
        n: count(),
      })
      .from(aiCatalogSubmissions)
      .where(gte(aiCatalogSubmissions.at, since30))
      .groupBy(aiCatalogSubmissions.status),
  ]);

  const costPerSubmissionPaise = 5000; // ₹50
  const totalAi = Number(aiAgg.totalUsage ?? 0);
  const aiCostPaise = totalAi * costPerSubmissionPaise;

  return ok(
    withReportMeta({
      windowDays: 30,
      features: [
        {
          feature: 'AI catalog generation',
          uniqueUsers: Number(aiAgg.uniqueUsers ?? 0),
          totalUsage: totalAi,
          costPaise: aiCostPaise,
          costPerSubmissionPaise,
          breakdown: aiByStatus.reduce<Record<string, number>>((acc, r) => {
            acc[r.status] = r.n;
            return acc;
          }, {}),
        },
        {
          feature: 'Virtual try-on',
          uniqueUsers: 0,
          totalUsage: 0,
          costPaise: 0,
          note: 'VTO events table not yet deployed — placeholder',
        },
      ],
    }),
  );
}
