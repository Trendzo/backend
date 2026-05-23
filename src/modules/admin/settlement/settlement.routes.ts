import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './settlement.controller.js';
import {
  BillingCloseBody,
  BillingStatementsQuery,
  IdParam,
  MarkCompleteBody,
  MarkFailedBody,
  PayoutListQuery,
  PayoutPreviewBody,
  PayoutRunBody,
} from './settlement.validators.js';

const adminSettlementRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/payouts',
    {
      preHandler: requirePermission('payouts.view'),
      schema: { querystring: PayoutListQuery },
    },
    async (req) => ctrl.listPayouts({ query: req.query }),
  );

  app.get(
    '/payouts/:id',
    {
      preHandler: requirePermission('payouts.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getPayout(req.params.id),
  );

  app.get(
    '/tail-of-cycle',
    { preHandler: requirePermission('payouts.view') },
    async () => ctrl.getTailOfCycle(),
  );

  app.get(
    '/billing-console',
    { preHandler: requirePermission('payouts.view') },
    async () => ctrl.getBillingConsole(),
  );

  app.post(
    '/payouts/preview',
    {
      preHandler: requirePermission('payouts.initiate'),
      schema: { body: PayoutPreviewBody },
    },
    async (req) => ctrl.previewPayoutCycle({ body: req.body }),
  );

  app.post(
    '/payouts/run-cycle',
    {
      preHandler: requirePermission('payouts.initiate'),
      schema: { body: PayoutRunBody },
    },
    async (req) => ctrl.runPayoutCycle({ body: req.body, auth: getAuth(req) }),
  );

  app.post(
    '/payouts/:id/initiate',
    {
      preHandler: requirePermission('payouts.initiate'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.initiatePayout({ id: req.params.id, auth: getAuth(req) }),
  );

  app.post(
    '/payouts/:id/mark-complete',
    {
      preHandler: requirePermission('payouts.initiate'),
      schema: { params: IdParam, body: MarkCompleteBody },
    },
    async (req) => ctrl.markPayoutComplete({ id: req.params.id, body: req.body, auth: getAuth(req) }),
  );

  app.post(
    '/payouts/:id/mark-failed',
    {
      preHandler: requirePermission('payouts.initiate'),
      schema: { params: IdParam, body: MarkFailedBody },
    },
    async (req) => ctrl.markPayoutFailed({ id: req.params.id, body: req.body, auth: getAuth(req) }),
  );

  app.post(
    '/payouts/:id/retry',
    {
      preHandler: requirePermission('payouts.initiate'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.retryFailedPayout({ id: req.params.id, auth: getAuth(req) }),
  );

  app.post(
    '/billing/close',
    {
      preHandler: requirePermission('payouts.initiate'),
      schema: { body: BillingCloseBody },
    },
    async (req) => ctrl.closeBillingPeriod({ body: req.body }),
  );

  app.get(
    '/billing-statements',
    {
      preHandler: requirePermission('payouts.view'),
      schema: { querystring: BillingStatementsQuery },
    },
    async (req) => ctrl.listBillingStatements({ query: req.query }),
  );

  app.get(
    '/billing-statements/:id/pdf',
    {
      preHandler: requirePermission('payouts.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getBillingStatementPdf({ id: req.params.id }),
  );
};

export default adminSettlementRoutes;
