/**
 * Retailer-side returns + held-items. Scoped to the authenticated retailer's store.
 *
 * - GET  /retailer/returns
 * - GET  /retailer/returns/:id
 * - POST /retailer/orders/:id/returns/open-counter   (counter return)
 * - POST /retailer/orders/:id/returns/standard       (post-delivery return)
 * - POST /retailer/returns/:id/verify                 (store verification)
 * - POST /retailer/returns/:id/mark-received          (goods arrived — starts verify window)
 * - GET  /retailer/held-items
 * - POST /retailer/held-items/:id/collect-at-counter
 * - POST /retailer/held-items/:id/redeliver
 * - POST /retailer/held-items/:id/record-disposition
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './returns.controller.js';
import {
  DeclineBody,
  IdParam,
  ListHeldQuery,
  ListReturnsQuery,
  OpenCounterBody,
  RecordDispositionBody,
  StandardReturnBody,
  VerifyBody,
} from './returns.validators.js';

const retailerReturnsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  app.get(
    '/returns',
    {
      preHandler: requirePermission('returns.view'),
      schema: { querystring: ListReturnsQuery },
    },
    async (req) => ctrl.listReturns({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/returns/:id',
    {
      preHandler: requirePermission('returns.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getReturn({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/orders/:id/returns/open-counter',
    {
      preHandler: requirePermission('returns.accept'),
      schema: { params: IdParam, body: OpenCounterBody },
    },
    async (req) =>
      ctrl.openCounter({
        auth: getAuth(req),
        orderId: req.params.id,
        body: req.body,
      }),
  );

  app.post(
    '/orders/:id/returns/standard',
    {
      preHandler: requirePermission('returns.accept'),
      schema: { params: IdParam, body: StandardReturnBody },
    },
    async (req) =>
      ctrl.openStandard({
        auth: getAuth(req),
        orderId: req.params.id,
        body: req.body,
      }),
  );

  app.post(
    '/returns/:id/verify',
    {
      preHandler: requirePermission('returns.accept'),
      schema: { params: IdParam, body: VerifyBody },
    },
    async (req) =>
      ctrl.verifyReturnHandler({
        auth: getAuth(req),
        id: req.params.id,
        body: req.body,
      }),
  );

  app.post(
    '/returns/:id/mark-received',
    {
      preHandler: requirePermission('returns.accept'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.markReceived({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/returns/:id/decline',
    {
      preHandler: requirePermission('returns.accept'),
      schema: { params: IdParam, body: DeclineBody },
    },
    async (req) =>
      ctrl.declineReturnHandler({
        auth: getAuth(req),
        id: req.params.id,
        body: req.body,
      }),
  );

  app.get(
    '/held-items',
    {
      preHandler: requirePermission('held_items.view'),
      schema: { querystring: ListHeldQuery },
    },
    async (req) => ctrl.listHeldItems({ auth: getAuth(req), query: req.query }),
  );

  app.post(
    '/held-items/:id/collect-at-counter',
    {
      preHandler: requirePermission('held_items.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.collectAtCounter({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/held-items/:id/redeliver',
    {
      preHandler: requirePermission('held_items.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.redeliver({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/held-items/:id/record-disposition',
    {
      preHandler: requirePermission('held_items.view'),
      schema: { params: IdParam, body: RecordDispositionBody },
    },
    async (req) =>
      ctrl.recordDisposition({
        auth: getAuth(req),
        id: req.params.id,
        body: req.body,
      }),
  );
};

export default retailerReturnsRoutes;
