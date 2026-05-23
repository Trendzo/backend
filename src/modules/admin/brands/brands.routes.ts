import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './brands.controller.js';
import { CreateBody, IdParam, ListQuery, PatchBody } from './brands.validators.js';

const adminBrandsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/',
    { schema: { querystring: ListQuery } },
    async (req) => ctrl.listBrands({ query: req.query }),
  );

  app.post(
    '/',
    { schema: { body: CreateBody } },
    async (req) => ctrl.createBrand({ body: req.body }),
  );

  app.patch(
    '/:id',
    { schema: { params: IdParam, body: PatchBody } },
    async (req) => ctrl.patchBrand({ id: req.params.id, body: req.body }),
  );

  app.delete(
    '/:id',
    { schema: { params: IdParam } },
    async (req) => ctrl.deleteBrand({ id: req.params.id }),
  );
};

export default adminBrandsRoutes;
