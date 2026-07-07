/** Admin dispatch desk routes. Mounted at /admin/dispatch. */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './dispatch.controller.js';
import { AssignDriverBody, OrderIdParam } from './dispatch.validators.js';

const adminDispatchRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/drivers',
    { preHandler: requirePermission('dispatch.view') },
    async () => ctrl.listDrivers(),
  );

  app.get(
    '/orders',
    { preHandler: requirePermission('dispatch.view') },
    async () => ctrl.listUnassignedOrders(),
  );

  app.post(
    '/orders/:id/assign',
    {
      preHandler: requirePermission('dispatch.manage'),
      schema: { params: OrderIdParam, body: AssignDriverBody },
    },
    async (req) => ctrl.assignDriver({ id: req.params.id, body: req.body }),
  );

  app.post(
    '/orders/:id/reassign',
    {
      preHandler: requirePermission('dispatch.manage'),
      schema: { params: OrderIdParam, body: AssignDriverBody },
    },
    async (req) => ctrl.assignDriver({ id: req.params.id, body: req.body }),
  );

  app.post(
    '/orders/:id/unassign',
    {
      preHandler: requirePermission('dispatch.manage'),
      schema: { params: OrderIdParam },
    },
    async (req) => ctrl.unassignDriver({ id: req.params.id }),
  );
};

export default adminDispatchRoutes;
