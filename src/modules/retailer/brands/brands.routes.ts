import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './brands.controller.js';
import { CreateBody, IdParam, PatchLogoBody } from './brands.validators.js';

const retailerBrandsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  app.get(
    '/',
    {
      preHandler: requirePermission('listings.view'),
    },
    async (req) => ctrl.listBrands({ actor: getAuth(req) }),
  );

  app.post(
    '/',
    {
      preHandler: requirePermission('listings.create'),
      schema: { body: CreateBody },
    },
    async (req) => ctrl.createBrand({ body: req.body, actor: getAuth(req) }),
  );

  app.patch(
    '/:id/logo',
    {
      preHandler: requirePermission('listings.edit'),
      schema: { params: IdParam, body: PatchLogoBody },
    },
    async (req) =>
      ctrl.patchBrandLogo({ id: req.params.id, body: req.body, actor: getAuth(req) }),
  );
};

export default retailerBrandsRoutes;
