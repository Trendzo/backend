/** Admin driver directory + management. Mounted at /admin/drivers. */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './drivers.controller.js';
import { IdParam, ListDriversQuery } from './drivers.validators.js';

const adminDriversRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/',
    {
      preHandler: requirePermission('drivers.view'),
      schema: { querystring: ListDriversQuery },
    },
    async (req) => ctrl.listDrivers({ query: req.query }),
  );

  app.post(
    '/:id/suspend',
    {
      preHandler: requirePermission('drivers.manage'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.suspendDriver({ id: req.params.id }),
  );

  app.post(
    '/:id/activate',
    {
      preHandler: requirePermission('drivers.manage'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.activateDriver({ id: req.params.id }),
  );
};

export default adminDriversRoutes;
