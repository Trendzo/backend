import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './settlement.controller.js';
import { IdParam, LimitQuery } from './settlement.validators.js';

const retailerSettlementRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  app.get(
    '/payouts',
    {
      preHandler: requirePermission('payouts.view'),
      schema: { querystring: LimitQuery },
    },
    async (req) => ctrl.listPayouts({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/payouts/:id',
    {
      preHandler: requirePermission('payouts.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getPayout({ auth: getAuth(req), id: req.params.id }),
  );

  app.get(
    '/billing-statements',
    {
      preHandler: requirePermission('payouts.view'),
      schema: { querystring: LimitQuery },
    },
    async (req) => ctrl.listBillingStatements({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/billing-statements/:id',
    {
      preHandler: requirePermission('payouts.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getBillingStatement({ auth: getAuth(req), id: req.params.id }),
  );

  app.get(
    '/payouts/upcoming',
    { preHandler: requirePermission('payouts.view') },
    async (req) => ctrl.getUpcomingPayout({ auth: getAuth(req) }),
  );

  app.get(
    '/payouts/:id/deductions',
    {
      preHandler: requirePermission('payouts.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getPayoutDeductions({ auth: getAuth(req), id: req.params.id }),
  );

  app.get(
    '/billing-statements/:id/pdf',
    {
      preHandler: requirePermission('payouts.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getBillingStatementPdf({ auth: getAuth(req), id: req.params.id }),
  );
};

export default retailerSettlementRoutes;
