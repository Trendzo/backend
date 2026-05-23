import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './early-disbursement.controller.js';
import { CreateRequestBody } from './early-disbursement.validators.js';

const retailerEarlyDisbursementRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  app.get(
    '/early-disbursement',
    { preHandler: requirePermission('early_disbursement.request') },
    async (req) => ctrl.listRequests({ auth: getAuth(req) }),
  );

  app.post(
    '/early-disbursement',
    {
      preHandler: requirePermission('early_disbursement.request'),
      schema: { body: CreateRequestBody },
    },
    async (req) =>
      ctrl.createRequest({ auth: getAuth(req), body: req.body }),
  );
};

export default retailerEarlyDisbursementRoutes;
