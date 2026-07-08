/** Driver COD cash routes. Mounted at /driver/cash, gated by requireAuth('driver'). */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './cash.controller.js';
import { RequestDepositBody } from './cash.validators.js';

const driverCashRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('driver'));

  app.get('/balance', async (req) => ctrl.getBalance({ auth: getAuth(req) }));

  app.get('/deposits', async (req) => ctrl.listDeposits({ auth: getAuth(req) }));

  app.post(
    '/deposits',
    { schema: { body: RequestDepositBody } },
    async (req) => ctrl.requestDeposit({ auth: getAuth(req), body: req.body }),
  );
};

export default driverCashRoutes;
