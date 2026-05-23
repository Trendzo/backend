import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './listings.controller.js';
import { SearchQuery } from './listings.validators.js';

const adminListingsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/',
    { schema: { querystring: SearchQuery } },
    async (req) => ctrl.searchListings({ query: req.query }),
  );
};

export default adminListingsRoutes;
