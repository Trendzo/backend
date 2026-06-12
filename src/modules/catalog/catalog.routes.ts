import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import * as ctrl from './catalog.controller.js';
import {
  BrandsQuery,
  CategoriesQuery,
  CollectionsQuery,
  SizeScalesQuery,
  SlugParam,
} from './catalog.validators.js';

/**
 * Public read-only catalog metadata. No auth required — retailer UIs read these to
 * populate brand/category dropdowns; consumer-facing browse uses richer endpoints later.
 */
const catalogRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/categories',
    { schema: { querystring: CategoriesQuery } },
    async (req) => ctrl.listCategories({ query: req.query }),
  );

  app.get(
    '/size-scales',
    { schema: { querystring: SizeScalesQuery } },
    async (req) => ctrl.listSizeScales({ query: req.query }),
  );

  app.get(
    '/brands',
    { schema: { querystring: BrandsQuery } },
    async (req) => ctrl.listBrands({ query: req.query }),
  );

  app.get(
    '/collections',
    { schema: { querystring: CollectionsQuery } },
    async (req) => ctrl.listCollections({ query: req.query }),
  );

  app.get(
    '/collections/:slug',
    { schema: { params: SlugParam } },
    async (req) => ctrl.getCollection(req.params.slug),
  );
};

export default catalogRoutes;
