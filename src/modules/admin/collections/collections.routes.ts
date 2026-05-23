import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './collections.controller.js';
import {
  CreateBody,
  IdParam,
  ListQuery,
  ListingsBody,
  PatchBody,
} from './collections.validators.js';

const adminCollectionsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/',
    { schema: { querystring: ListQuery } },
    async (req) => ctrl.listCollections({ query: req.query }),
  );

  app.post(
    '/',
    { schema: { body: CreateBody } },
    async (req) => ctrl.createCollection({ body: req.body }),
  );

  app.get(
    '/:id',
    { schema: { params: IdParam } },
    async (req) => ctrl.getCollection({ id: req.params.id }),
  );

  app.patch(
    '/:id',
    { schema: { params: IdParam, body: PatchBody } },
    async (req) => ctrl.patchCollection({ id: req.params.id, body: req.body }),
  );

  app.delete(
    '/:id',
    { schema: { params: IdParam } },
    async (req) => ctrl.deleteCollection({ id: req.params.id }),
  );

  app.put(
    '/:id/listings',
    { schema: { params: IdParam, body: ListingsBody } },
    async (req) =>
      ctrl.setCollectionListings({ id: req.params.id, body: req.body }),
  );
};

export default adminCollectionsRoutes;
