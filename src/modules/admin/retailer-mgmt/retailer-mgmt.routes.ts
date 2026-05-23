import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './retailer-mgmt.controller.js';
import {
  IdParam,
  OptionalReasonBody,
  ReasonBody,
  RetailerCreateBody,
  RetailerEditBody,
} from './retailer-mgmt.validators.js';

const adminRetailerMgmtRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.post(
    '/create',
    {
      preHandler: requirePermission('store_management.edit'),
      schema: { body: RetailerCreateBody },
    },
    async (req) =>
      ctrl.createRetailer({ auth: getAuth(req), body: req.body, requestId: req.id }),
  );

  app.get(
    '/:id',
    {
      preHandler: requirePermission('store_management.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getRetailer({ id: req.params.id }),
  );

  app.patch(
    '/:id',
    {
      preHandler: requirePermission('store_management.edit'),
      schema: { params: IdParam, body: RetailerEditBody },
    },
    async (req) =>
      ctrl.editRetailer({
        auth: getAuth(req),
        id: req.params.id,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/:id/ban',
    {
      preHandler: requirePermission('retailer.terminate'),
      schema: { params: IdParam, body: ReasonBody },
    },
    async (req) =>
      ctrl.banRetailer({
        auth: getAuth(req),
        id: req.params.id,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/:id/unban',
    {
      preHandler: requirePermission('retailer.reinstate'),
      schema: { params: IdParam, body: OptionalReasonBody },
    },
    async (req) =>
      ctrl.unbanRetailer({
        auth: getAuth(req),
        id: req.params.id,
        body: req.body,
        requestId: req.id,
      }),
  );
};

export default adminRetailerMgmtRoutes;
