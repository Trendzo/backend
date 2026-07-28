/**
 * GET /consumer/rewards — vouchers issued to this account personally.
 *
 * Separate from `/promotions/active`, which lists what everyone can use and deliberately
 * excludes vouchers. Without this endpoint a prize won on the wheel existed only in the
 * database and in a toast.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from '@/modules/public/spin/spin.controller.js';

const consumerRewardsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('consumer'));
  app.get('/', async (req) => ctrl.listRewards({ auth: getAuth(req) }));
};

export default consumerRewardsRoutes;
