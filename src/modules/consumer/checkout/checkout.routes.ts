import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './checkout.controller.js';
import { OrderIdParam, PlaceOrderBody, QuoteBody } from './checkout.validators.js';

const consumerCheckoutRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('consumer'));

  app.post(
    '/quote',
    { schema: { body: QuoteBody } },
    async (req) => ctrl.getQuote({ auth: getAuth(req), body: req.body }),
  );

  app.post(
    '/',
    { schema: { body: PlaceOrderBody } },
    async (req) => ctrl.placeConsumerOrder({ auth: getAuth(req), body: req.body }),
  );

  app.get('/orders', async (req) => ctrl.listOrders({ auth: getAuth(req) }));

  app.get(
    '/orders/:id',
    { schema: { params: OrderIdParam } },
    async (req) => ctrl.getOrder({ auth: getAuth(req), id: req.params.id }),
  );
};

export default consumerCheckoutRoutes;
