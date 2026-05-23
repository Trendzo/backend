import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './retailers.controller.js';
import {
  IdParam,
  ListQuery,
  RejectBody,
  SuspendBody,
  TerminateBody,
  UnsuspendBody,
} from './retailers.validators.js';

const adminRetailersRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/',
    { schema: { querystring: ListQuery } },
    async (req) => ctrl.listRetailers({ query: req.query }),
  );

  app.post(
    '/:id/approve',
    { schema: { params: IdParam } },
    async (req) => ctrl.approveRetailer({ id: req.params.id }),
  );

  app.post(
    '/:id/reject',
    { schema: { params: IdParam, body: RejectBody } },
    async (req) =>
      ctrl.rejectRetailer({ id: req.params.id, body: req.body, log: req.log }),
  );

  app.post(
    '/:id/suspend',
    { schema: { params: IdParam, body: SuspendBody } },
    async (req) =>
      ctrl.suspendRetailer({ id: req.params.id, body: req.body, log: req.log }),
  );

  app.post(
    '/:id/unsuspend',
    { schema: { params: IdParam, body: UnsuspendBody } },
    async (req) =>
      ctrl.unsuspendRetailer({ id: req.params.id, body: req.body, log: req.log }),
  );

  app.post(
    '/:id/terminate',
    {
      preHandler: requirePermission('retailer.terminate'),
      schema: { params: IdParam, body: TerminateBody },
    },
    async (req) =>
      ctrl.terminateRetailer({
        auth: getAuth(req),
        id: req.params.id,
        body: req.body,
        requestId: req.id,
      }),
  );
};

export default adminRetailersRoutes;
