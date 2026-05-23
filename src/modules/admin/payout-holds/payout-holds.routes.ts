import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './payout-holds.controller.js';
import {
  CreateHoldBody,
  IdParam,
  ListHoldsQuery,
  ReleaseHoldBody,
} from './payout-holds.validators.js';

const adminPayoutHoldsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/payout-holds',
    {
      preHandler: requirePermission('payouts.hold'),
      schema: { querystring: ListHoldsQuery },
    },
    async (req) => ctrl.listHolds({ query: req.query }),
  );

  app.post(
    '/payout-holds',
    {
      preHandler: requirePermission('payouts.hold'),
      schema: { body: CreateHoldBody },
    },
    async (req) => ctrl.postHold({ body: req.body, auth: getAuth(req) }),
  );

  app.post(
    '/payout-holds/:id/release',
    {
      preHandler: requirePermission('payouts.hold'),
      schema: { params: IdParam, body: ReleaseHoldBody },
    },
    async (req) => ctrl.postRelease({ id: req.params.id, body: req.body, auth: getAuth(req) }),
  );
};

export default adminPayoutHoldsRoutes;
