import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './events.controller.js';
import { CartAddBody, ListingViewBody } from './events.validators.js';

const consumerEventsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('consumer'));

  app.post(
    '/listing-view',
    { schema: { body: ListingViewBody } },
    async (req) => ctrl.recordListingView({ auth: getAuth(req), body: req.body }),
  );

  app.post(
    '/cart-add',
    { schema: { body: CartAddBody } },
    async (req) => ctrl.recordCartAdd({ auth: getAuth(req), body: req.body }),
  );
};

export default consumerEventsRoutes;
