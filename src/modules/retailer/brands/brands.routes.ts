import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './brands.controller.js';
import { CreateBody } from './brands.validators.js';

const retailerBrandsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  app.post(
    '/',
    {
      preHandler: requirePermission('listings.create'),
      schema: { body: CreateBody },
    },
    async (req) => ctrl.createBrand({ body: req.body }),
  );
};

export default retailerBrandsRoutes;
