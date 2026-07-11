import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import * as ctrl from './abandoned-carts.controller.js';
import { ListAbandonedCartsQuery } from './abandoned-carts.validators.js';

/**
 * Public abandoned-carts routes — NO auth hook (mounted alongside the other public
 * surfaces). Returns the abandoned count and each cart's item list, filtered by
 * query params (staleMinutes, consumerId, limit, offset).
 */
const publicAbandonedCartsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/',
    { schema: { querystring: ListAbandonedCartsQuery } },
    async (req) => ctrl.listAbandonedCarts({ query: req.query }),
  );
};

export default publicAbandonedCartsRoutes;
