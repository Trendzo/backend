import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './gift-cards.controller.js';
import { RedeemBody } from './gift-cards.validators.js';

const consumerGiftCardRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('consumer'));

  app.get('/', async (req) => ctrl.listGiftCards({ auth: getAuth(req) }));

  app.post(
    '/redeem',
    { schema: { body: RedeemBody } },
    async (req) => ctrl.redeem({ auth: getAuth(req), body: req.body }),
  );
};

export default consumerGiftCardRoutes;
