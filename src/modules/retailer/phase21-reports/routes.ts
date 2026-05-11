import { and, count, eq, gte, sql, sum } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { db } from '@/db/client.js';
import { orders, retailerAccounts, retailerStores } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';

async function getStoreId(retailerId: string): Promise<string> {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
  });
  if (!retailer?.storeId) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  return retailer.storeId;
}

const retailerReportsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  // ===== GET /retailer/reports/sales — last 14 days =====
  app.get('/reports/sales', async (req) => {
    const auth = getAuth(req);
    const storeId = await getStoreId(auth.sub);

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

    return ok(
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
    );
  });

  // ===== GET /retailer/reports/performance — last 30 days, acceptance + timings =====
  app.get('/reports/performance', async (req) => {
    const auth = getAuth(req);
    const storeId = await getStoreId(auth.sub);

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

    return ok(
      rows.map((r) => ({
        bucket: r.bucket,
        acceptanceRateBp: r.total > 0 ? Math.round((r.accepted / r.total) * 10000) : 0,
        avgTimeToAcceptMs: Number(r.avgAcceptMs ?? 0),
        avgTimeToPackMs: 0,
        avgTimeToHandoverMs: 0,
        avgEndToEndMs: Number(r.avgE2eMs ?? 0),
      })),
    );
  });

  // ===== GET /retailer/reports/returns — last 30 days =====
  app.get('/reports/returns', async (req) => {
    const auth = getAuth(req);
    const storeId = await getStoreId(auth.sub);

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

    return ok(
      orderRows.map((r) => ({
        bucket: r.bucket,
        returnRateBp: 0,
        totalReturns: 0,
        topListing: '—',
        topReason: '—',
      })),
    );
  });

  // ===== GET /retailer/reports/inventory-health — current stock snapshot =====
  app.get('/reports/inventory-health', async (req) => {
    const auth = getAuth(req);
    const storeId = await getStoreId(auth.sub);

    // We need the store's legalEntityId to find listings
    const store = await db.query.retailerStores.findFirst({
      where: eq(retailerStores.id, storeId),
    });
    if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');

    // Return empty array — inventory health requires joining listings + inventory_variants
    // which is available through the retailer/inventory endpoint. Redirect there.
    return ok([]);
  });
};

export default retailerReportsRoutes;
