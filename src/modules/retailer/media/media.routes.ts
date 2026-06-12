import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './media.controller.js';
import { IdParam, ListMediaQuery } from './media.validators.js';

const retailerMediaRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  // Multipart upload — no body schema (validated inside the controller).
  app.post(
    '/media',
    { preHandler: requirePermission('listings.edit') },
    async (req) => ctrl.uploadMedia(req),
  );

  app.get(
    '/media',
    {
      preHandler: requirePermission('listings.view'),
      schema: { querystring: ListMediaQuery },
    },
    async (req) => ctrl.listMedia({ auth: getAuth(req), query: req.query }),
  );

  app.delete(
    '/media/:id',
    {
      preHandler: requirePermission('listings.edit'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.deleteMedia({ auth: getAuth(req), id: req.params.id }),
  );
};

export default retailerMediaRoutes;
