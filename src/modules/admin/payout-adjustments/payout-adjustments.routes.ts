import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './payout-adjustments.controller.js';
import {
  CreateAdjustmentBody,
  ListAdjustmentsQuery,
} from './payout-adjustments.validators.js';

const adminPayoutAdjustmentsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/payout-adjustments',
    {
      preHandler: requirePermission('payouts.hold'),
      schema: { querystring: ListAdjustmentsQuery },
    },
    async (req) => ctrl.listAdjustments({ query: req.query }),
  );

  app.post(
    '/payout-adjustments',
    {
      preHandler: requirePermission('payouts.hold'),
      schema: { body: CreateAdjustmentBody },
    },
    async (req) => ctrl.postAdjustment({ body: req.body, auth: getAuth(req) }),
  );
};

export default adminPayoutAdjustmentsRoutes;
