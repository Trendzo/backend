/**
 * Retailer-side order management. Scoped to the authenticated retailer's storeId.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './orders.controller.js';
import {
  DoorCloseBody,
  DoorExtendBody,
  HandoverBody,
  IdParam,
  ListQuery,
  MarkDeliveredBody,
  MarkUndeliveredBody,
  PickupHandoverBody,
  RequestCancelBody,
} from './orders.validators.js';

const retailerOrderRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  app.get(
    '/',
    {
      preHandler: requirePermission('orders.view'),
      schema: { querystring: ListQuery },
    },
    async (req) => ctrl.listOrders({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/:id',
    {
      preHandler: requirePermission('orders.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getOrder({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/:id/accept',
    {
      preHandler: requirePermission('orders.accept'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.acceptOrder({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/:id/pack',
    {
      preHandler: requirePermission('orders.pack'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.packOrder({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/:id/pickup-handover',
    {
      preHandler: requirePermission('orders.mark_delivered'),
      schema: { params: IdParam, body: PickupHandoverBody },
    },
    async (req) =>
      ctrl.pickupHandover({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );

  app.post(
    '/:id/handover',
    {
      preHandler: requirePermission('orders.handover'),
      schema: { params: IdParam, body: HandoverBody },
    },
    async (req) => ctrl.handover({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );

  app.post(
    '/:id/depart',
    {
      preHandler: requirePermission('orders.handover'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.depart({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/:id/mark-delivered',
    {
      preHandler: requirePermission('orders.mark_delivered'),
      schema: { params: IdParam, body: MarkDeliveredBody },
    },
    async (req) =>
      ctrl.markDelivered({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );

  app.post(
    '/:id/mark-undelivered',
    {
      preHandler: requirePermission('orders.mark_delivered'),
      schema: { params: IdParam, body: MarkUndeliveredBody },
    },
    async (req) =>
      ctrl.markUndelivered({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );

  app.post(
    '/:id/request-cancel',
    {
      preHandler: requirePermission('orders.cancel_request'),
      schema: { params: IdParam, body: RequestCancelBody },
    },
    async (req) =>
      ctrl.requestCancel({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );

  app.post(
    '/:id/door/open',
    {
      preHandler: requirePermission('orders.handover'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.doorOpen({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/:id/door/extend',
    {
      preHandler: requirePermission('orders.handover'),
      schema: { params: IdParam, body: DoorExtendBody },
    },
    async (req) =>
      ctrl.doorExtend({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );

  app.post(
    '/:id/door/close',
    {
      preHandler: requirePermission('orders.handover'),
      schema: { params: IdParam, body: DoorCloseBody },
    },
    async (req) =>
      ctrl.doorClose({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );
};

export default retailerOrderRoutes;
