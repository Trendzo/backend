/** Admin dispatch desk routes. Mounted at /admin/dispatch. */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './dispatch.controller.js';
import {
  AssignDriverBody,
  CreateReversePickupBody,
  ListReversePickupsQuery,
  OrderIdParam,
} from './dispatch.validators.js';

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
    async () => ctrl.listPackedOrders(),
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

  // ── Reverse pickups ──
  app.get(
    '/reverse-pickups',
    {
      preHandler: requirePermission('dispatch.view'),
      schema: { querystring: ListReversePickupsQuery },
    },
    async (req) => ctrl.listReversePickups({ query: req.query }),
  );

  app.post(
    '/reverse-pickups',
    {
      preHandler: requirePermission('dispatch.manage'),
      schema: { body: CreateReversePickupBody },
    },
    async (req) => ctrl.createReversePickupAdmin({ body: req.body }),
  );

  app.post(
    '/reverse-pickups/:id/assign',
    {
      preHandler: requirePermission('dispatch.manage'),
      schema: { params: OrderIdParam, body: AssignDriverBody },
    },
    async (req) => ctrl.assignReversePickup({ id: req.params.id, body: req.body }),
  );

  app.post(
    '/reverse-pickups/:id/unassign',
    {
      preHandler: requirePermission('dispatch.manage'),
      schema: { params: OrderIdParam },
    },
    async (req) => ctrl.unassignReversePickup({ id: req.params.id }),
  );

  app.post(
    '/reverse-pickups/:id/cancel',
    {
      preHandler: requirePermission('dispatch.manage'),
      schema: { params: OrderIdParam },
    },
    async (req) => ctrl.cancelReversePickup({ id: req.params.id }),
  );
};

export default adminDispatchRoutes;
