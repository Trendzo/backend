import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './store-orders.controller.js';
import {
  BulkOrderIdsBody,
  HandoverBody,
  MarkDeliveredBody,
  MarkUndeliveredBody,
  RequestCancelBody,
  StoreOrderParam,
  StoreParam,
} from './store-orders.validators.js';

const adminStoreOrdersRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  const forceXn = { preHandler: requirePermission('orders.force_transition') };

  app.post(
    '/:storeId/orders/:orderId/accept',
    { ...forceXn, schema: { params: StoreOrderParam } },
    async (req) =>
      ctrl.acceptOrder({
        auth: getAuth(req),
        storeId: req.params.storeId,
        orderId: req.params.orderId,
        requestId: req.id,
      }),
  );

  app.post(
    '/:storeId/orders/:orderId/pack',
    { ...forceXn, schema: { params: StoreOrderParam } },
    async (req) =>
      ctrl.packOrder({
        auth: getAuth(req),
        storeId: req.params.storeId,
        orderId: req.params.orderId,
        requestId: req.id,
      }),
  );

  app.post(
    '/:storeId/orders/:orderId/handover',
    { ...forceXn, schema: { params: StoreOrderParam, body: HandoverBody } },
    async (req) =>
      ctrl.handoverOrder({
        auth: getAuth(req),
        storeId: req.params.storeId,
        orderId: req.params.orderId,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/:storeId/orders/:orderId/depart',
    { ...forceXn, schema: { params: StoreOrderParam } },
    async (req) =>
      ctrl.departOrder({
        auth: getAuth(req),
        storeId: req.params.storeId,
        orderId: req.params.orderId,
        requestId: req.id,
      }),
  );

  app.post(
    '/:storeId/orders/:orderId/mark-delivered',
    { ...forceXn, schema: { params: StoreOrderParam, body: MarkDeliveredBody } },
    async (req) =>
      ctrl.markDelivered({
        auth: getAuth(req),
        storeId: req.params.storeId,
        orderId: req.params.orderId,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/:storeId/orders/:orderId/mark-undelivered',
    { ...forceXn, schema: { params: StoreOrderParam, body: MarkUndeliveredBody } },
    async (req) =>
      ctrl.markUndelivered({
        auth: getAuth(req),
        storeId: req.params.storeId,
        orderId: req.params.orderId,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/:storeId/orders/:orderId/request-cancel',
    {
      preHandler: requirePermission('orders.cancel'),
      schema: { params: StoreOrderParam, body: RequestCancelBody },
    },
    async (req) =>
      ctrl.requestCancel({
        auth: getAuth(req),
        storeId: req.params.storeId,
        orderId: req.params.orderId,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/:storeId/orders/bulk-accept',
    { ...forceXn, schema: { params: StoreParam, body: BulkOrderIdsBody } },
    async (req) =>
      ctrl.bulkAccept({
        auth: getAuth(req),
        storeId: req.params.storeId,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/:storeId/orders/bulk-pack',
    { ...forceXn, schema: { params: StoreParam, body: BulkOrderIdsBody } },
    async (req) =>
      ctrl.bulkPack({
        auth: getAuth(req),
        storeId: req.params.storeId,
        body: req.body,
        requestId: req.id,
      }),
  );
};

export default adminStoreOrdersRoutes;
