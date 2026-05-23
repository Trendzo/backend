import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './categories.controller.js';
import { CreateBody, IdParam, ListQuery, PatchBody } from './categories.validators.js';

const adminCategoriesRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/',
    { schema: { querystring: ListQuery } },
    async (req) => ctrl.listCategories({ query: req.query }),
  );

  app.post(
    '/',
    { schema: { body: CreateBody } },
    async (req) => ctrl.createCategory({ body: req.body }),
  );

  app.patch(
    '/:id',
    { schema: { params: IdParam, body: PatchBody } },
    async (req) => ctrl.patchCategory({ id: req.params.id, body: req.body }),
  );

  app.delete(
    '/:id',
    { schema: { params: IdParam } },
    async (req) => ctrl.deleteCategory({ id: req.params.id }),
  );
};

export default adminCategoriesRoutes;
