/**
 * Driver delivery routes. Mounted at /driver/deliveries, gated purely by
 * `requireAuth('driver')` + per-order ownership in the controller (no permission
 * matrix — a driver is a single-role standalone identity, like a consumer).
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './deliveries.controller.js';
import {
  DeliverBody,
  DoorCloseBody,
  DoorExtendBody,
  IdParam,
  ListDeliveriesQuery,
  MarkUndeliveredBody,
} from './deliveries.validators.js';

const driverDeliveriesRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('driver'));

  app.get(
    '/',
    { schema: { querystring: ListDeliveriesQuery } },
    async (req) => ctrl.listDeliveries({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/:id',
    { schema: { params: IdParam } },
    async (req) => ctrl.getDelivery({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/:id/depart',
    { schema: { params: IdParam } },
    async (req) => ctrl.depart({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/:id/deliver',
    { schema: { params: IdParam, body: DeliverBody } },
    async (req) => ctrl.deliver({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );

  app.post(
    '/:id/door/open',
    { schema: { params: IdParam } },
    async (req) => ctrl.doorOpen({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/:id/door/extend',
    { schema: { params: IdParam, body: DoorExtendBody } },
    async (req) => ctrl.doorExtend({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );

  app.post(
    '/:id/door/close',
    { schema: { params: IdParam, body: DoorCloseBody } },
    async (req) => ctrl.doorClose({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );

  app.post(
    '/:id/undelivered',
    { schema: { params: IdParam, body: MarkUndeliveredBody } },
    async (req) => ctrl.markUndelivered({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );

  app.post(
    '/:id/return',
    { schema: { params: IdParam } },
    async (req) => ctrl.returnToStore({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/:id/returned',
    { schema: { params: IdParam } },
    async (req) => ctrl.markReturned({ auth: getAuth(req), id: req.params.id }),
  );
};

export default driverDeliveriesRoutes;
