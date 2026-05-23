import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './store-returns.controller.js';
import {
  ListHeldQuery,
  ListReturnsQuery,
  OpenCounterBody,
  RecordDispositionBody,
  StoreHeldParam,
  StoreOrderParam,
  StoreParam,
  StoreReturnParam,
  VerifyBody,
} from './store-returns.validators.js';

const adminStoreReturnsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/:storeId/returns',
    {
      preHandler: requirePermission('orders.view'),
      schema: { params: StoreParam, querystring: ListReturnsQuery },
    },
    async (req) => ctrl.listReturns({ storeId: req.params.storeId, query: req.query }),
  );

  app.post(
    '/:storeId/orders/:orderId/returns/open-counter',
    {
      preHandler: requirePermission('orders.force_transition'),
      schema: { params: StoreOrderParam, body: OpenCounterBody },
    },
    async (req) =>
      ctrl.openCounter({
        auth: getAuth(req),
        storeId: req.params.storeId,
        orderId: req.params.orderId,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/:storeId/returns/:returnId/verify',
    {
      preHandler: requirePermission('orders.force_transition'),
      schema: { params: StoreReturnParam, body: VerifyBody },
    },
    async (req) =>
      ctrl.verifyReturnHandler({
        auth: getAuth(req),
        storeId: req.params.storeId,
        returnId: req.params.returnId,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.get(
    '/:storeId/held-items',
    {
      preHandler: requirePermission('held_items.view'),
      schema: { params: StoreParam, querystring: ListHeldQuery },
    },
    async (req) => ctrl.listHeldItems({ storeId: req.params.storeId, query: req.query }),
  );

  app.post(
    '/:storeId/held-items/:id/collect-at-counter',
    {
      preHandler: requirePermission('held_items.extend'),
      schema: { params: StoreHeldParam },
    },
    async (req) =>
      ctrl.collectAtCounter({
        auth: getAuth(req),
        storeId: req.params.storeId,
        id: req.params.id,
        requestId: req.id,
      }),
  );

  app.post(
    '/:storeId/held-items/:id/redeliver',
    {
      preHandler: requirePermission('held_items.extend'),
      schema: { params: StoreHeldParam },
    },
    async (req) =>
      ctrl.redeliver({
        auth: getAuth(req),
        storeId: req.params.storeId,
        id: req.params.id,
        requestId: req.id,
      }),
  );

  app.post(
    '/:storeId/held-items/:id/record-disposition',
    {
      preHandler: requirePermission('held_items.extend'),
      schema: { params: StoreHeldParam, body: RecordDispositionBody },
    },
    async (req) =>
      ctrl.recordDisposition({
        auth: getAuth(req),
        storeId: req.params.storeId,
        id: req.params.id,
        body: req.body,
        requestId: req.id,
      }),
  );
};

export default adminStoreReturnsRoutes;
