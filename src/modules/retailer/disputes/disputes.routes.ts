import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './disputes.controller.js';
import { IdParam, ListDisputesQuery } from './disputes.validators.js';

const retailerDisputeRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  app.get(
    '/disputes',
    {
      preHandler: requirePermission('disputes.view'),
      schema: { querystring: ListDisputesQuery },
    },
    async (req) => ctrl.listDisputes({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/disputes/:id',
    {
      preHandler: requirePermission('disputes.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getDispute({ auth: getAuth(req), id: req.params.id }),
  );
};

export default retailerDisputeRoutes;
