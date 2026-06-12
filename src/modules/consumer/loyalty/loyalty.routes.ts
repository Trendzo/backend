import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './loyalty.controller.js';
import { TxnListQuery } from './loyalty.validators.js';

const consumerLoyaltyRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('consumer'));

  app.get(
    '/',
    { schema: { querystring: TxnListQuery } },
    async (req) => ctrl.getLoyalty({ auth: getAuth(req), query: req.query }),
  );
};

export default consumerLoyaltyRoutes;
