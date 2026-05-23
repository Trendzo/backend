import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './orders.controller.js';
import {
  CancelBody,
  DismissCancelBody,
  DoorCloseBody,
  DoorExtendBody,
  FeeOverrideBody,
  IdParam,
  ListOrdersQuery,
  PlaceTestOrderBody,
  RerouteBody,
  StoreIdParam,
} from './orders.validators.js';

const adminOrderRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.post(
    '/test-orders',
    {
      preHandler: requirePermission('simulate.run'),
      schema: { body: PlaceTestOrderBody },
    },
    async (req) =>
      ctrl.placeTestOrder({
        adminId: req.auth?.sub ?? 'admin',
        body: req.body,
      }),
  );

  app.get(
    '/orders',
    {
      preHandler: requirePermission('orders.view'),
      schema: { querystring: ListOrdersQuery },
    },
    async (req) => ctrl.listOrders({ query: req.query }),
  );

  app.get(
    '/orders/cancellation-requests',
    { preHandler: requirePermission('orders.view') },
    async () => ctrl.listCancellationRequests(),
  );

  app.get(
    '/orders/acceptance-timeout',
    { preHandler: requirePermission('orders.view') },
    async () => ctrl.listAcceptanceTimeout(),
  );

  app.get(
    '/orders/:id',
    {
      preHandler: requirePermission('orders.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getOrderDetail(req.params.id),
  );

  app.post(
    '/orders/:id/cancel-request/dismiss',
    {
      preHandler: requirePermission('orders.cancel'),
      schema: { params: IdParam, body: DismissCancelBody },
    },
    async (req) =>
      ctrl.dismissCancelRequest({
        orderId: req.params.id,
        adminId: req.auth?.sub ?? 'admin',
        body: req.body,
      }),
  );

  app.post(
    '/orders/:id/cancel',
    {
      preHandler: requirePermission('orders.cancel'),
      schema: { params: IdParam, body: CancelBody },
    },
    async (req) =>
      ctrl.cancelOrderHandler({
        orderId: req.params.id,
        adminId: req.auth?.sub ?? 'admin',
        body: req.body,
      }),
  );

  app.post(
    '/orders/:id/fee-override',
    {
      preHandler: requirePermission('orders.force_transition'),
      schema: { params: IdParam, body: FeeOverrideBody },
    },
    async (req) =>
      ctrl.setFeeOverride({
        orderId: req.params.id,
        adminId: req.auth?.sub ?? 'admin',
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/orders/:id/door/open',
    {
      preHandler: requirePermission('orders.force_transition'),
      schema: { params: IdParam },
    },
    async (req) =>
      ctrl.openDoorVisit({
        orderId: req.params.id,
        adminId: req.auth?.sub ?? 'admin',
      }),
  );

  app.post(
    '/orders/:id/door/extend',
    {
      preHandler: requirePermission('orders.force_transition'),
      schema: { params: IdParam, body: DoorExtendBody },
    },
    async (req) =>
      ctrl.extendDoorVisit({
        orderId: req.params.id,
        adminId: req.auth?.sub ?? 'admin',
        reason: req.body.reason,
      }),
  );

  app.post(
    '/orders/:id/door/close',
    {
      preHandler: requirePermission('orders.force_transition'),
      schema: { params: IdParam, body: DoorCloseBody },
    },
    async (req) =>
      ctrl.closeDoorVisit({
        orderId: req.params.id,
        adminId: req.auth?.sub ?? 'admin',
        items: req.body.items,
      }),
  );

  app.get(
    '/stores/:storeId/catalog',
    {
      preHandler: requirePermission('store_management.view'),
      schema: { params: StoreIdParam },
    },
    async (req) => ctrl.getStoreCatalog(req.params.storeId),
  );

  app.get(
    '/orders/:id/price-snapshot',
    {
      preHandler: requirePermission('orders.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getPriceSnapshot(req.params.id),
  );

  app.post(
    '/orders/:id/reroute',
    {
      preHandler: requirePermission('orders.force_transition'),
      schema: { params: IdParam, body: RerouteBody },
    },
    async (req) =>
      ctrl.rerouteOrderHandler({
        orderId: req.params.id,
        adminId: req.auth?.sub ?? 'admin',
        body: req.body,
      }),
  );

  app.get(
    '/orders/:id/invoices',
    {
      preHandler: requirePermission('orders.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.listInvoices(req.params.id),
  );
};

export default adminOrderRoutes;
