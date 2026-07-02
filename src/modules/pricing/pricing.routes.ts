/**
 * Pricing routes — PUBLIC with optional auth. Guests get a clean preview; a consumer
 * token enriches the quote (loyalty/wallet eligibility). The one place the app reads
 * prices from.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuthOptional, optionalAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './pricing.controller.js';
import { PriceCartBody, PriceQuoteBody } from './pricing.validators.js';

const pricingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', optionalAuth('consumer'));

  app.post(
    '/quote',
    { schema: { body: PriceQuoteBody } },
    async (req) => ctrl.priceOrder({ auth: getAuthOptional(req), body: req.body }),
  );

  app.post(
    '/cart',
    { schema: { body: PriceCartBody } },
    async (req) => ctrl.priceCart({ auth: getAuthOptional(req), body: req.body }),
  );
};

export default pricingRoutes;
