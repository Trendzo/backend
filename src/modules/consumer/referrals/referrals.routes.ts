import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './referrals.controller.js';
import { RedeemBody } from './referrals.validators.js';

const consumerReferralRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('consumer'));

  app.get('/me', async (req) => ctrl.getMine({ auth: getAuth(req) }));

  app.post(
    '/redeem',
    { schema: { body: RedeemBody } },
    async (req) => ctrl.redeem({ auth: getAuth(req), body: req.body }),
  );
};

export default consumerReferralRoutes;
