import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import { toCsv } from '@/shared/reports/meta.js';
import * as ctrl from './reports.controller.js';

const LeaderboardQuery = z.object({
  topN: z.coerce.number().int().min(1).max(50).default(10),
});

const adminReportsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

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
    '/reports/headline',
    { preHandler: requirePermission('reports.view') },
    async () => ctrl.getHeadline(),
  );

  app.get(
    '/reports/leaderboard',
    {
      preHandler: requirePermission('reports.view'),
      schema: { querystring: LeaderboardQuery },
    },
    async (req) => ctrl.getLeaderboard({ query: req.query }),
  );

  app.get(
    '/reports/below-floor',
    { preHandler: requirePermission('reports.view') },
    async () => ctrl.getBelowFloor(),
  );

  app.get(
    '/reports/compliance',
    { preHandler: requirePermission('reports.view') },
    async () => ctrl.getCompliance(),
  );

  app.get(
    '/reports/funnel',
    { preHandler: requirePermission('reports.view') },
    async () => ctrl.getFunnel(),
  );

  app.get(
    '/reports/operational',
    { preHandler: requirePermission('reports.view') },
    async () => ctrl.getOperational(),
  );

  app.get(
    '/reports/feature-usage',
    { preHandler: requirePermission('reports.view') },
    async () => ctrl.getFeatureUsage(),
  );
};

export default adminReportsRoutes;
