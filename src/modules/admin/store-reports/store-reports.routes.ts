import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import { toCsv } from '@/shared/reports/meta.js';
import * as ctrl from '@/modules/retailer/reports/reports.controller.js';

/**
 * §21 admin drill-into-retailer reports.
 *
 * Reuses retailer report controllers by passing `storeIdOverride` so admins
 * can view any store's numbers without a parallel reporting code path.
 */

const Params = z.object({ storeId: z.string().uuid() });

const SalesDetailedQuery = z.object({
  granularity: z.enum(['day', 'week', 'month']).default('day'),
  breakdown: z.enum(['status', 'delivery_method', 'category']).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
});

const DateRangeQuery = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
});

const ListingsRevenueQuery = DateRangeQuery.extend({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const VariantConversionQuery = DateRangeQuery.extend({
  listingId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const TopListLimitQuery = DateRangeQuery.extend({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const DeadStockQuery = z.object({
  daysWithoutSale: z.coerce.number().int().min(1).max(3650).default(30),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const PayoutCyclesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(24),
});

const adminStoreReportsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // CSV intercept — same shape as retailer routes (parse raw URL because
  // unknown query params are stripped by Zod schemas).
  app.addHook('onSend', async (req, reply, payload) => {
    const [path, qs] = req.url.split('?');
    if (!path?.includes('/reports/')) return payload;
    if (!qs || !/(^|&)format=csv(&|$)/.test(qs)) return payload;
    let parsed: unknown;
    try {
      parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch {
      return payload;
    }
    const data = (parsed as { data?: unknown })?.data ?? parsed;
    let src: unknown = data;
    if (src && typeof src === 'object' && 'rows' in (src as Record<string, unknown>)) {
      src = (src as Record<string, unknown>).rows;
    }
    void reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="report.csv"');
    return toCsv(src);
  });

  app.get(
    '/:storeId/reports/sales',
    { preHandler: requirePermission('reports.view'), schema: { params: Params } },
    async (req) => ctrl.getSales({ auth: getAuth(req), storeIdOverride: req.params.storeId }),
  );

  app.get(
    '/:storeId/reports/performance',
    { preHandler: requirePermission('reports.view'), schema: { params: Params } },
    async (req) => ctrl.getPerformance({ auth: getAuth(req), storeIdOverride: req.params.storeId }),
  );

  app.get(
    '/:storeId/reports/returns',
    { preHandler: requirePermission('reports.view'), schema: { params: Params } },
    async (req) => ctrl.getReturns({ auth: getAuth(req), storeIdOverride: req.params.storeId }),
  );

  app.get(
    '/:storeId/reports/inventory-health',
    { preHandler: requirePermission('reports.view'), schema: { params: Params } },
    async (req) => ctrl.getInventoryHealth({ auth: getAuth(req), storeIdOverride: req.params.storeId }),
  );

  app.get(
    '/:storeId/reports/sales-detailed',
    {
      preHandler: requirePermission('reports.view'),
      schema: { params: Params, querystring: SalesDetailedQuery },
    },
    async (req) => ctrl.getSalesDetailed({ auth: getAuth(req), storeIdOverride: req.params.storeId, query: req.query }),
  );

  app.get(
    '/:storeId/reports/revenue-summary',
    {
      preHandler: requirePermission('reports.view'),
      schema: { params: Params, querystring: DateRangeQuery },
    },
    async (req) => ctrl.getRevenueSummary({ auth: getAuth(req), storeIdOverride: req.params.storeId, query: req.query }),
  );

  app.get(
    '/:storeId/reports/listings/revenue',
    {
      preHandler: requirePermission('reports.view'),
      schema: { params: Params, querystring: ListingsRevenueQuery },
    },
    async (req) => ctrl.getListingsRevenue({ auth: getAuth(req), storeIdOverride: req.params.storeId, query: req.query }),
  );

  app.get(
    '/:storeId/reports/listings/conversion',
    {
      preHandler: requirePermission('reports.view'),
      schema: { params: Params, querystring: VariantConversionQuery },
    },
    async (req) => ctrl.getVariantConversion({ auth: getAuth(req), storeIdOverride: req.params.storeId, query: req.query }),
  );

  app.get(
    '/:storeId/reports/returns/top-listings',
    {
      preHandler: requirePermission('reports.view'),
      schema: { params: Params, querystring: TopListLimitQuery },
    },
    async (req) => ctrl.getReturnsTopListings({ auth: getAuth(req), storeIdOverride: req.params.storeId, query: req.query }),
  );

  app.get(
    '/:storeId/reports/listings/best-sellers',
    {
      preHandler: requirePermission('reports.view'),
      schema: { params: Params, querystring: TopListLimitQuery },
    },
    async (req) => ctrl.getBestSellers({ auth: getAuth(req), storeIdOverride: req.params.storeId, query: req.query }),
  );

  app.get(
    '/:storeId/reports/listings/dead-stock',
    {
      preHandler: requirePermission('reports.view'),
      schema: { params: Params, querystring: DeadStockQuery },
    },
    async (req) => ctrl.getDeadStock({ auth: getAuth(req), storeIdOverride: req.params.storeId, query: req.query }),
  );

  app.get(
    '/:storeId/reports/payouts/cycles',
    {
      preHandler: requirePermission('reports.view'),
      schema: { params: Params, querystring: PayoutCyclesQuery },
    },
    async (req) => ctrl.getPayoutCycles({ auth: getAuth(req), storeIdOverride: req.params.storeId, query: req.query }),
  );

  app.get(
    '/:storeId/reports/compliance',
    { preHandler: requirePermission('reports.view'), schema: { params: Params } },
    async (req) => ctrl.getCompliance({ auth: getAuth(req), storeIdOverride: req.params.storeId }),
  );

  app.get(
    '/:storeId/reports/platform-promo-commission',
    { preHandler: requirePermission('reports.view'), schema: { params: Params } },
    async (req) => ctrl.getPlatformPromoCommission({ auth: getAuth(req), storeIdOverride: req.params.storeId }),
  );
};

export default adminStoreReportsRoutes;
