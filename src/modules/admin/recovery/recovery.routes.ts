import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './recovery.controller.js';
import { IdParam, ListRecoveriesQuery } from './recovery.validators.js';

const adminPostPayoutRecoveryRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/post-payout-recovery',
    {
      preHandler: requirePermission('post_payout_recovery.manage'),
      schema: { querystring: ListRecoveriesQuery },
    },
    async (req) => ctrl.listRecoveries({ query: req.query }),
  );

  app.post(
    '/post-payout-recovery/:id/cancel',
    {
      preHandler: requirePermission('post_payout_recovery.manage'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.cancelRecovery(req.params.id),
  );
};

export default adminPostPayoutRecoveryRoutes;
