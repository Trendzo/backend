import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import { toCsv } from '@/shared/reports/meta.js';
import * as ctrl from './reports.controller.js';
import * as gstCtrl from './gst-reports.controller.js';

const GstPeriodQuery = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  channel: z.enum(['all', 'pos', 'online']).optional(),
});

const SalesDetailedQuery = z.object({
  granularity: z.enum(['day', 'week', 'month']).default('day'),
  breakdown: z.enum(['status', 'delivery_method', 'category']).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
});

const RevenueSummaryQuery = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
});

const ListingsRevenueQuery = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const VariantConversionQuery = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  listingId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const ReturnsTopQuery = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const BestSellersQuery = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const DeadStockQuery = z.object({
  daysWithoutSale: z.coerce.number().int().min(1).max(3650).default(30),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const PayoutCyclesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(24),
});

const retailerReportsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  // CSV intercept: when ?format=csv on any /reports/* GET, replace the serialized JSON
  // payload with CSV bytes (parse raw URL since Zod schemas strip unknown query params).
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
    '/reports/sales',
    { preHandler: requirePermission('reports.view') },
    async (req) => ctrl.getSales({ auth: getAuth(req) }),
  );

  app.get(
    '/reports/performance',
    { preHandler: requirePermission('reports.view') },
    async (req) => ctrl.getPerformance({ auth: getAuth(req) }),
  );

  app.get(
    '/reports/returns',
    { preHandler: requirePermission('reports.view') },
    async (req) => ctrl.getReturns({ auth: getAuth(req) }),
  );

  app.get(
    '/reports/inventory-health',
    { preHandler: requirePermission('reports.view') },
    async (req) => ctrl.getInventoryHealth({ auth: getAuth(req) }),
  );

  app.get(
    '/reports/sales-detailed',
    {
      preHandler: requirePermission('reports.view'),
      schema: { querystring: SalesDetailedQuery },
    },
    async (req) => ctrl.getSalesDetailed({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/reports/revenue-summary',
    {
      preHandler: requirePermission('reports.view'),
      schema: { querystring: RevenueSummaryQuery },
    },
    async (req) => ctrl.getRevenueSummary({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/reports/listings/revenue',
    {
      preHandler: requirePermission('reports.view'),
      schema: { querystring: ListingsRevenueQuery },
    },
    async (req) => ctrl.getListingsRevenue({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/reports/listings/conversion',
    {
      preHandler: requirePermission('reports.view'),
      schema: { querystring: VariantConversionQuery },
    },
    async (req) => ctrl.getVariantConversion({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/reports/returns/top-listings',
    {
      preHandler: requirePermission('reports.view'),
      schema: { querystring: ReturnsTopQuery },
    },
    async (req) => ctrl.getReturnsTopListings({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/reports/listings/best-sellers',
    {
      preHandler: requirePermission('reports.view'),
      schema: { querystring: BestSellersQuery },
    },
    async (req) => ctrl.getBestSellers({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/reports/listings/dead-stock',
    {
      preHandler: requirePermission('reports.view'),
      schema: { querystring: DeadStockQuery },
    },
    async (req) => ctrl.getDeadStock({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/reports/payouts/cycles',
    {
      preHandler: requirePermission('reports.view'),
      schema: { querystring: PayoutCyclesQuery },
    },
    async (req) => ctrl.getPayoutCycles({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/reports/compliance',
    { preHandler: requirePermission('reports.view') },
    async (req) => ctrl.getCompliance({ auth: getAuth(req) }),
  );

  app.get(
    '/reports/platform-promo-commission',
    { preHandler: requirePermission('reports.view') },
    async (req) => ctrl.getPlatformPromoCommission({ auth: getAuth(req) }),
  );

  // ── GST filing-support (offline counter / POS sales) ──
  app.get(
    '/reports/gst/summary',
    { preHandler: requirePermission('reports.view'), schema: { querystring: GstPeriodQuery } },
    async (req) => gstCtrl.getGstSummary({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/reports/gst/hsn-summary',
    { preHandler: requirePermission('reports.view'), schema: { querystring: GstPeriodQuery } },
    async (req) => gstCtrl.getGstHsnSummary({ auth: getAuth(req), query: req.query }),
  );
};

export default retailerReportsRoutes;
