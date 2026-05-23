import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './listings.controller.js';
import {
  BulkCreateVariantsBody,
  BulkStatusBody,
  CreateListingBody,
  CreateVariantBody,
  IdParam,
  ListingIdParam,
  ListQuery,
  PatchListingBody,
  PatchVariantBody,
} from './listings.validators.js';

const retailerListingsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  app.post(
    '/listings',
    {
      preHandler: requirePermission('listings.create'),
      schema: { body: CreateListingBody },
    },
    async (req) => ctrl.createListing({ auth: getAuth(req), body: req.body }),
  );

  app.get(
    '/listings',
    {
      preHandler: requirePermission('listings.view'),
      schema: { querystring: ListQuery },
    },
    async (req) => ctrl.listListings({ auth: getAuth(req), query: req.query }),
  );

  app.patch(
    '/listings/:id',
    {
      preHandler: requirePermission('listings.edit'),
      schema: { params: IdParam, body: PatchListingBody },
    },
    async (req) =>
      ctrl.patchListing({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );

  app.delete(
    '/listings/:id',
    {
      preHandler: requirePermission('listings.retire'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.deleteListing({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/listings/:listingId/variants',
    {
      preHandler: requirePermission('listings.edit'),
      schema: { params: ListingIdParam, body: CreateVariantBody },
    },
    async (req) =>
      ctrl.createVariant({
        auth: getAuth(req),
        listingId: req.params.listingId,
        body: req.body,
      }),
  );

  app.post(
    '/listings/:listingId/variants/bulk',
    {
      preHandler: requirePermission('listings.edit'),
      schema: { params: ListingIdParam, body: BulkCreateVariantsBody },
    },
    async (req) =>
      ctrl.bulkCreateVariants({
        auth: getAuth(req),
        listingId: req.params.listingId,
        body: req.body,
      }),
  );

  app.get(
    '/listings/:listingId/variants',
    {
      preHandler: requirePermission('listings.view'),
      schema: { params: ListingIdParam },
    },
    async (req) =>
      ctrl.listVariants({ auth: getAuth(req), listingId: req.params.listingId }),
  );

  app.get(
    '/listings/:listingId/effective-pricing',
    {
      preHandler: requirePermission('listings.view'),
      schema: { params: ListingIdParam },
    },
    async (req) =>
      ctrl.getEffectivePricing({ auth: getAuth(req), listingId: req.params.listingId }),
  );

  app.patch(
    '/variants/:id',
    {
      preHandler: requirePermission('listings.edit'),
      schema: { params: IdParam, body: PatchVariantBody },
    },
    async (req) =>
      ctrl.patchVariant({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );

  app.delete(
    '/variants/:id',
    {
      preHandler: requirePermission('listings.edit'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.deleteVariant({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/listings/bulk-status',
    {
      preHandler: requirePermission('listings.publish'),
      schema: { body: BulkStatusBody },
    },
    async (req) => ctrl.bulkStatus({ auth: getAuth(req), body: req.body }),
  );

  app.get(
    '/listings/:id/audit',
    {
      preHandler: requirePermission('listings.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.listingAudit({ auth: getAuth(req), id: req.params.id }),
  );

  app.get(
    '/audit/recent-price-changes',
    { preHandler: requirePermission('listings.view') },
    async (req) => ctrl.recentPriceChanges({ auth: getAuth(req) }),
  );
};

export default retailerListingsRoutes;
