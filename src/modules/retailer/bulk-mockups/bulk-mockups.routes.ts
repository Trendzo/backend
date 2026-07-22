import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './bulk-mockups.controller.js';
import { EnqueueBody, IdParam, ListQuery } from './bulk-mockups.validators.js';

const retailerBulkMockupsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  app.post(
    '/bulk-mockups',
    {
      preHandler: requirePermission('ai_catalog.generate'),
      schema: { body: EnqueueBody },
    },
    async (req) => ctrl.enqueue({ auth: getAuth(req), body: req.body }),
  );

  app.get(
    '/bulk-mockups',
    {
      preHandler: requirePermission('ai_catalog.generate'),
      schema: { querystring: ListQuery },
    },
    async (req) => ctrl.list({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/bulk-mockups/summary',
    { preHandler: requirePermission('ai_catalog.generate') },
    async (req) => ctrl.summary({ auth: getAuth(req) }),
  );

  app.post(
    '/bulk-mockups/:id/cancel',
    {
      preHandler: requirePermission('ai_catalog.generate'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.cancel({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/bulk-mockups/:id/dismiss',
    {
      preHandler: requirePermission('ai_catalog.generate'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.dismiss({ auth: getAuth(req), id: req.params.id }),
  );
};

export default retailerBulkMockupsRoutes;
