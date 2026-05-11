import { and, count, eq, gte, isNotNull, sql, sum } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { db } from '@/db/client.js';
import {
  aiCatalogSubmissions,
  disputes,
  orders,
  payouts,
  supportTickets,
} from '@/db/schema/index.js';
import { ok } from '@/shared/http/envelope.js';
import { requireAuth } from '@/shared/auth/middleware.js';

const ACCEPTANCE_FLOOR_BP = 8000; // 80%
const FULFILMENT_FLOOR_BP = 8500; // 85%

const adminReportsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // ===== GET /admin/reports/leaderboard — last 30 days =====
  app.get('/reports/leaderboard', async () => {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [orderStats, disputeStats] = await Promise.all([
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
    ]);

    const disputeMap = new Map(disputeStats.map((d) => [d.storeId, d.disputeCount]));

    // Compute scores and rank
    const ranked = orderStats
      .map((s) => {
        const total = s.total > 0 ? s.total : 1;
        const acceptanceRateBp = Math.round((s.accepted / total) * 10000);
        const fulfilmentScoreBp = Math.round((s.delivered / total) * 10000);
        const dc = Number(disputeMap.get(s.storeId) ?? 0);
        const disputeRateBp = Math.round((dc / total) * 10000);
        const score = acceptanceRateBp * 0.5 + fulfilmentScoreBp * 0.4 + (10000 - disputeRateBp) * 0.1;
        return {
          retailerId: s.storeId,
          retailerName: s.storeName,
          acceptanceRateBp,
          fulfilmentScoreBp,
          returnRateBp: 0,
          disputeRateBp,
          score,
        };
      })
      .sort((a, b) => b.score - a.score)
      .map((r, i) => ({ rank: i + 1, ...r, score: undefined }));

    return ok(ranked);
  });

  // ===== GET /admin/reports/compliance — stores below performance floor =====
  app.get('/reports/compliance', async () => {
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
      .having(sql`COUNT(*) >= 5`); // skip stores with < 5 orders (not statistically meaningful)

    const breaches: Array<{
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
          retailerName: name,
          metric: 'Acceptance rate',
          value: `${(acceptBp / 100).toFixed(1)}%`,
          threshold: `${(ACCEPTANCE_FLOOR_BP / 100).toFixed(0)}%`,
          daysBelow: 30,
        });
      }
      if (fulfilBp < FULFILMENT_FLOOR_BP) {
        breaches.push({
          retailerName: name,
          metric: 'Fulfilment rate',
          value: `${(fulfilBp / 100).toFixed(1)}%`,
          threshold: `${(FULFILMENT_FLOOR_BP / 100).toFixed(0)}%`,
          daysBelow: 30,
        });
      }
    }

    return ok(breaches);
  });

  // ===== GET /admin/reports/funnel — order-stage funnel (last 30 days) =====
  app.get('/reports/funnel', async () => {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [total, accepted, delivered] = await Promise.all([
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
      { label: 'Order placed', count: total },
      { label: 'Accepted by retailer', count: accepted },
      { label: 'Delivered to consumer', count: delivered },
    ];

    return ok(
      steps.map((s, i) => ({
        label: s.label,
        count: s.count,
        dropoffPctFromPrevious:
          i === 0 ? 0 : steps[i - 1]!.count > 0 ? ((steps[i - 1]!.count - s.count) / steps[i - 1]!.count) * 100 : 0,
      })),
    );
  });

  // ===== GET /admin/reports/operational — platform throughput metrics =====
  app.get('/reports/operational', async () => {
    const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [orderStats, orderStats7, failedPayouts, openTickets] = await Promise.all([
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
    ]);

    const ordersPerDay7 = Math.round(orderStats7 / 7);
    const gmv = Number(orderStats.grossPaise ?? 0);

    const metrics = [
      { metric: 'Orders / day (7d avg)', value: ordersPerDay7.toLocaleString('en-IN'), trendBp: 0 },
      { metric: 'Orders (30d total)', value: Number(orderStats.total).toLocaleString('en-IN'), trendBp: 0 },
      { metric: 'Avg acceptance time', value: fmtMs(Number(orderStats.avgAcceptMs ?? 0)), trendBp: 0 },
      { metric: 'Avg end-to-end time', value: fmtMs(Number(orderStats.avgE2eMs ?? 0)), trendBp: 0 },
      { metric: 'GMV (30d)', value: `₹${(gmv / 100).toLocaleString('en-IN', { minimumFractionDigits: 0 })}`, trendBp: 0 },
      { metric: 'Failed payouts', value: failedPayouts.toLocaleString('en-IN'), trendBp: 0 },
      { metric: 'Open support tickets', value: openTickets.toLocaleString('en-IN'), trendBp: 0 },
    ];

    return ok(metrics);
  });

  // ===== GET /admin/reports/feature-usage — AI catalog + placeholder features =====
  app.get('/reports/feature-usage', async () => {
    const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const aiStats = await db
      .select({
        uniqueUsers: sql<number>`COUNT(DISTINCT ${aiCatalogSubmissions.storeId})::int`,
        totalUsage: count(),
        costPaise: sql<number>`(COUNT(*) * 5000)::int`, // ₹50 per submission placeholder
      })
      .from(aiCatalogSubmissions)
      .where(gte(aiCatalogSubmissions.at, since30))
      .then((r) => r[0]!);

    return ok([
      {
        feature: 'AI catalog generation',
        uniqueUsers: Number(aiStats.uniqueUsers ?? 0),
        totalUsage: Number(aiStats.totalUsage ?? 0),
        costPaise: Number(aiStats.costPaise ?? 0),
      },
      { feature: 'Virtual try-on', uniqueUsers: 0, totalUsage: 0, costPaise: 0 },
      { feature: 'Daily check-in', uniqueUsers: 0, totalUsage: 0, costPaise: 0 },
      { feature: 'Lucky draw', uniqueUsers: 0, totalUsage: 0, costPaise: 0 },
    ]);
  });
};

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

export default adminReportsRoutes;
