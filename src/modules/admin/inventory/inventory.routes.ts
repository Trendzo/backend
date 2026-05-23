import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './inventory.controller.js';
import {
  CreateAdjustmentBody,
  ListAdjustmentsQuery,
  ListReservationsQuery,
} from './inventory.validators.js';

const adminInventoryRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/inventory/adjustments',
    { schema: { querystring: ListAdjustmentsQuery } },
    async (req) => ctrl.listAdjustments({ query: req.query }),
  );

  app.post(
    '/inventory/adjustments',
    { schema: { body: CreateAdjustmentBody } },
    async (req) =>
      ctrl.createAdjustment({
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
      }),
  );

  app.get(
    '/inventory/reservations',
    { schema: { querystring: ListReservationsQuery } },
    async (req) => ctrl.listReservations({ query: req.query }),
  );
};

export default adminInventoryRoutes;
