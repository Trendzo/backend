import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './order-groups.controller.js';
import { IdParam } from './order-groups.validators.js';

const adminOrderGroupRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/order-groups/:id',
    {
      preHandler: requirePermission('orders.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getOrderGroup(req.params.id),
  );
};

export default adminOrderGroupRoutes;
