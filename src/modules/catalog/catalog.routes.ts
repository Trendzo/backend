import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import * as ctrl from './catalog.controller.js';
import {
  BrandsQuery,
  CategoriesQuery,
  CollectionQuery,
  CollectionsQuery,
  FacetsQuery,
  IdParam,
  NearbyStoresQuery,
  PickupSlotsQuery,
  ProductReviewsQuery,
  ProductsQuery,
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
    '/facets',
    { schema: { querystring: FacetsQuery } },
    async (req) => ctrl.listFacets({ query: req.query }),
  );

  app.get(
    '/products',
    { schema: { querystring: ProductsQuery } },
    async (req) => ctrl.listProducts({ query: req.query }),
  );

  app.get(
    '/products/:id',
    { schema: { params: IdParam } },
    async (req) => ctrl.getProduct(req.params.id),
  );

  app.get(
    '/products/:id/reviews',
    { schema: { params: IdParam, querystring: ProductReviewsQuery } },
    async (req) => ctrl.listProductReviews(req.params.id, req.query),
  );

  app.get(
    '/collections',
    { schema: { querystring: CollectionsQuery } },
    async (req) => ctrl.listCollections({ query: req.query }),
  );

  app.get(
    '/collections/:slug',
    { schema: { params: SlugParam, querystring: CollectionQuery } },
    async (req) => ctrl.getCollection(req.params.slug, req.query),
  );

  // Stores near a point, nearest first. Registered BEFORE /stores/:id so the
  // literal path is not swallowed by the parameterised one.
  app.get(
    '/stores/nearby',
    { schema: { querystring: NearbyStoresQuery } },
    async (req) => ctrl.listNearbyStores({ query: req.query }),
  );

  // Consumer-safe store detail: address, coordinates, hours, phone, gallery.
  app.get(
    '/stores/:id',
    { schema: { params: IdParam } },
    async (req) => ctrl.getStore(req.params.id),
  );

  // Concrete upcoming pickup windows for a store, expanded from its recurring
  // weekly template — the consumer app hands the chosen one back at placement.
  app.get(
    '/stores/:id/pickup-slots',
    { schema: { params: IdParam, querystring: PickupSlotsQuery } },
    async (req) => ctrl.listStorePickupSlots({ storeId: req.params.id, query: req.query }),
  );
};

export default catalogRoutes;
