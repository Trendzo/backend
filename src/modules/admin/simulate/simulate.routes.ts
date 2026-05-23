import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './simulate.controller.js';
import { SimulateSchema } from './simulate.validators.js';

const adminSimulateRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.post(
    '/promotions/simulate',
    {
      preHandler: requirePermission('simulate.run'),
      schema: { body: SimulateSchema },
    },
    async (req) => ctrl.simulatePromotion({ body: req.body }),
  );
};

export default adminSimulateRoutes;
