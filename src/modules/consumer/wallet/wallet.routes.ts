import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './wallet.controller.js';
import { TxnListQuery } from './wallet.validators.js';

const consumerWalletRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('consumer'));

  app.get(
    '/',
    { schema: { querystring: TxnListQuery } },
    async (req) => ctrl.getWallet({ auth: getAuth(req), query: req.query }),
  );
};

export default consumerWalletRoutes;
