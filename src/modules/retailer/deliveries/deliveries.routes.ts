/**
 * Delivery-agent routes (retailer sub-role 'delivery_agent'). Mounted at
 * /retailer/deliveries. Every order touched here must be assigned to the calling
 * agent (enforced in the controller).
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './deliveries.controller.js';
import {
  DoorCloseBody,
  DoorExtendBody,
  IdParam,
  ListDeliveriesQuery,
  MarkUndeliveredBody,
} from './deliveries.validators.js';

const deliveriesRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  app.get(
    '/',
    {
      preHandler: requirePermission('delivery.view'),
      schema: { querystring: ListDeliveriesQuery },
    },
    async (req) => ctrl.listDeliveries({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/:id',
    {
      preHandler: requirePermission('delivery.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getDelivery({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/:id/depart',
    {
      preHandler: requirePermission('delivery.act'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.depart({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/:id/door/open',
    {
      preHandler: requirePermission('delivery.act'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.doorOpen({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/:id/door/extend',
    {
      preHandler: requirePermission('delivery.act'),
      schema: { params: IdParam, body: DoorExtendBody },
    },
    async (req) => ctrl.doorExtend({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );

  app.post(
    '/:id/door/close',
    {
      preHandler: requirePermission('delivery.act'),
      schema: { params: IdParam, body: DoorCloseBody },
    },
    async (req) => ctrl.doorClose({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );

  app.post(
    '/:id/undelivered',
    {
      preHandler: requirePermission('delivery.act'),
      schema: { params: IdParam, body: MarkUndeliveredBody },
    },
    async (req) => ctrl.markUndelivered({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );
};

export default deliveriesRoutes;
