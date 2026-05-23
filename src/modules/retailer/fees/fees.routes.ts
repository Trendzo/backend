import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './fees.controller.js';

const retailerFeesRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  app.get(
    '/fees',
    { preHandler: requirePermission('store.view_profile') },
    async (req) => ctrl.getFees({ auth: getAuth(req) }),
  );
};

export default retailerFeesRoutes;
