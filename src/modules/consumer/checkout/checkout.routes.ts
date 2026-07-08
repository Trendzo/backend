import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './checkout.controller.js';
import {
  CancelOrderBody,
  OrderIdParam,
  PaymentFailedBody,
  PlaceGroupOrderBody,
  PlaceOrderBody,
  VerifyPaymentBody,
} from './checkout.validators.js';

// Dry-run pricing moved to the public, optional-auth /pricing surface (single source
// of truth for guests + signed-in users). This module now only places + manages orders.
const consumerCheckoutRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('consumer'));

  app.post(
    '/',
    { schema: { body: PlaceOrderBody } },
    async (req) => ctrl.placeConsumerOrder({ auth: getAuth(req), body: req.body }),
  );

  // Multi-retailer cart: one call, one group, one child order per store (all-or-nothing).
  app.post(
    '/group',
    { schema: { body: PlaceGroupOrderBody } },
    async (req) => ctrl.placeConsumerGroupOrder({ auth: getAuth(req), body: req.body }),
  );

  // ── Razorpay two-phase checkout ──
  app.post(
    '/verify-payment',
    { schema: { body: VerifyPaymentBody } },
    async (req) => ctrl.verifyPayment({ auth: getAuth(req), body: req.body }),
  );

  app.post(
    '/payment-failed',
    { schema: { body: PaymentFailedBody } },
    async (req) => ctrl.reportPaymentFailed({ auth: getAuth(req), body: req.body }),
  );

  app.post(
    '/orders/:id/retry-payment',
    { schema: { params: OrderIdParam } },
    async (req) => ctrl.retryPayment({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/group/:id/retry-payment',
    { schema: { params: OrderIdParam } },
    async (req) => ctrl.retryGroupPayment({ auth: getAuth(req), groupId: req.params.id }),
  );

  app.get('/orders', async (req) => ctrl.listOrders({ auth: getAuth(req) }));

  app.get(
    '/orders/:id',
    { schema: { params: OrderIdParam } },
    async (req) => ctrl.getOrder({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/orders/:id/cancel',
    { schema: { params: OrderIdParam, body: CancelOrderBody } },
    async (req) =>
      ctrl.cancelConsumerOrder({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );
};

export default consumerCheckoutRoutes;
