/**
 * Admin returns + refunds + held-items.
 *
 * - POST /admin/orders/:id/returns/open  (admin-on-behalf-of-consumer)
 * - GET  /admin/returns + GET /:id
 * - POST /admin/returns/:id/verify
 * - GET  /admin/refunds + GET /:id
 * - POST /admin/refunds/:id/disbursements/:dId/force-fail
 * - POST /admin/refunds/:id/disbursements/:dId/retry
 * - GET  /admin/held-items
 * - POST /admin/held-items/:id/extend
 * - POST /admin/held-items/:id/force-dispose
 * - POST /admin/held-items/:id/mark-expired
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './returns.controller.js';
import {
  ExtendHoldBody,
  ForceDisposeBody,
  ForceFailBody,
  IdParam,
  ListHeldQuery,
  ListRefundsQuery,
  ListReturnsQuery,
  OpenReturnBody,
  PayoutDeskQuery,
  RedirectToWalletBody,
  RefundDisbParam,
  SettleManualBody,
  VerifyBody,
} from './returns.validators.js';

const adminReturnsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.post(
    '/orders/:id/returns/open',
    {
      preHandler: requirePermission('orders.force_transition'),
      schema: { params: IdParam, body: OpenReturnBody },
    },
    async (req) =>
      ctrl.openReturnHandler({
        orderId: req.params.id,
        adminId: req.auth?.sub ?? 'admin',
        body: req.body,
      }),
  );

  app.get(
    '/returns',
    {
      preHandler: requirePermission('orders.view'),
      schema: { querystring: ListReturnsQuery },
    },
    async (req) => ctrl.listReturns({ query: req.query }),
  );

  app.get(
    '/returns/:id',
    {
      preHandler: requirePermission('orders.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getReturn(req.params.id),
  );

  app.post(
    '/returns/:id/verify',
    {
      preHandler: requirePermission('orders.force_transition'),
      schema: { params: IdParam, body: VerifyBody },
    },
    async (req) =>
      ctrl.verifyReturnHandler({
        id: req.params.id,
        adminId: req.auth?.sub ?? 'admin',
        body: req.body,
      }),
  );

  app.get(
    '/refunds',
    {
      preHandler: requirePermission('refunds.view'),
      schema: { querystring: ListRefundsQuery },
    },
    async (req) => ctrl.listRefunds({ query: req.query }),
  );

  app.get(
    '/refunds/:id',
    {
      preHandler: requirePermission('refunds.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getRefund(req.params.id),
  );

  app.post(
    '/refunds/:id/disbursements/:dId/force-fail',
    {
      preHandler: requirePermission('refunds.force'),
      schema: { params: RefundDisbParam, body: ForceFailBody },
    },
    async (req) =>
      ctrl.forceFail({
        dId: req.params.dId,
        adminId: req.auth?.sub ?? 'admin',
        body: req.body,
      }),
  );

  app.post(
    '/refunds/:id/disbursements/:dId/retry',
    {
      preHandler: requirePermission('refunds.force'),
      schema: { params: RefundDisbParam },
    },
    async (req) =>
      ctrl.retryDisb({
        dId: req.params.dId,
        adminId: req.auth?.sub ?? 'admin',
      }),
  );

  /**
   * Payout desk — refund legs with no automatic rail (COD cancellations, and cash
   * nobody has handed over yet). They are born PENDING and stay there until a human
   * moves real money, which is the deliberate counterpart to no longer fabricating a
   * "succeeded" for them. Reuses the existing refunds.view / refunds.force permissions,
   * so `support` stays read-only for free.
   */
  app.get(
    '/refunds/payout-desk',
    {
      preHandler: requirePermission('refunds.view'),
      schema: { querystring: PayoutDeskQuery },
    },
    async (req) => ctrl.payoutDesk({ query: req.query }),
  );

  app.post(
    '/refunds/:id/disbursements/:dId/settle-manual',
    {
      preHandler: requirePermission('refunds.force'),
      schema: { params: RefundDisbParam, body: SettleManualBody },
    },
    async (req) =>
      ctrl.settleManual({
        dId: req.params.dId,
        adminId: req.auth?.sub ?? 'admin',
        body: req.body,
      }),
  );

  app.post(
    '/refunds/:id/disbursements/:dId/redirect-to-wallet',
    {
      preHandler: requirePermission('refunds.force'),
      schema: { params: RefundDisbParam, body: RedirectToWalletBody },
    },
    async (req) =>
      ctrl.redirectToWallet({
        dId: req.params.dId,
        adminId: req.auth?.sub ?? 'admin',
        body: req.body,
      }),
  );

  app.get(
    '/held-items',
    {
      preHandler: requirePermission('held_items.view'),
      schema: { querystring: ListHeldQuery },
    },
    async (req) => ctrl.listHeldItems({ query: req.query }),
  );

  app.post(
    '/held-items/:id/extend',
    {
      preHandler: requirePermission('held_items.extend'),
      schema: { params: IdParam, body: ExtendHoldBody },
    },
    async (req) =>
      ctrl.extendHold({
        id: req.params.id,
        adminId: req.auth?.sub ?? 'admin',
        body: req.body,
      }),
  );

  app.post(
    '/held-items/:id/force-dispose',
    {
      preHandler: requirePermission('held_items.extend'),
      schema: { params: IdParam, body: ForceDisposeBody },
    },
    async (req) =>
      ctrl.forceDisposeHandler({
        id: req.params.id,
        adminId: req.auth?.sub ?? 'admin',
        body: req.body,
      }),
  );

  app.post(
    '/held-items/:id/mark-expired',
    {
      preHandler: requirePermission('held_items.extend'),
      schema: { params: IdParam },
    },
    async (req) =>
      ctrl.markExpiredHandler({
        id: req.params.id,
        adminId: req.auth?.sub ?? 'admin',
      }),
  );
};

export default adminReturnsRoutes;
