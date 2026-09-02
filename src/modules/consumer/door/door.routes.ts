/**
 * Consumer Try-and-Buy door routes. Mounted at /consumer/door, gated by
 * requireAuth('consumer') + per-order ownership in the controller.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './door.controller.js';
import { OrderItemParam, OrderParam } from './door.validators.js';

const consumerDoorRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('consumer'));

  app.get(
    '/orders/:id',
    { schema: { params: OrderParam } },
    async (req) => ctrl.getSession({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/orders/:id/items/:itemId/keep',
    { schema: { params: OrderItemParam } },
    async (req) => ctrl.keepItem({ auth: getAuth(req), id: req.params.id, itemId: req.params.itemId }),
  );

  app.post(
    '/orders/:id/items/:itemId/return',
    { schema: { params: OrderItemParam } },
    async (req) => ctrl.returnItem({ auth: getAuth(req), id: req.params.id, itemId: req.params.itemId }),
  );
};

export default consumerDoorRoutes;
