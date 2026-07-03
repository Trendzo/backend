import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './listings.controller.js';
import {
  BulkCreateGroupVariantsBody,
  BulkCreateVariantsBody,
  BulkStatusBody,
  CreateGroupBody,
  CreateGroupVariantBody,
  CreateListingBody,
  CreateVariantBody,
  DefaultVariantBody,
  GroupParam,
  IdParam,
  ListingIdParam,
  ListingsExportQuery,
  ListQuery,
  PatchGroupBody,
  PatchListingBody,
  PatchVariantBody,
  SkuAvailableQuery,
  VariantPubParam,
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

  // Full catalog CSV export (one row per variant). Static path — declared
  // before `/listings/:id` so it never matches the param route.
  app.get(
    '/listings/export',
    {
      preHandler: requirePermission('listings.view'),
      schema: { querystring: ListingsExportQuery },
    },
    async (req, reply) =>
      ctrl.exportListings({ auth: getAuth(req), query: req.query, reply }),
  );

  app.get(
    '/listings/:id',
    {
      preHandler: requirePermission('listings.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getListing({ auth: getAuth(req), id: req.params.id }),
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

  // ===== Variant groups (system color → size hierarchy) =====

  app.post(
    '/listings/:listingId/groups',
    {
      preHandler: requirePermission('listings.edit'),
      schema: { params: ListingIdParam, body: CreateGroupBody },
    },
    async (req) =>
      ctrl.createGroup({
        auth: getAuth(req),
        listingId: req.params.listingId,
        body: req.body,
      }),
  );

  app.patch(
    '/groups/:id',
    {
      preHandler: requirePermission('listings.edit'),
      schema: { params: IdParam, body: PatchGroupBody },
    },
    async (req) => ctrl.patchGroup({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );

  app.delete(
    '/groups/:id',
    {
      preHandler: requirePermission('listings.edit'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.deleteGroup({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/listings/:listingId/groups/:groupId/variants',
    {
      preHandler: requirePermission('listings.edit'),
      schema: { params: GroupParam, body: CreateGroupVariantBody },
    },
    async (req) =>
      ctrl.createGroupVariant({
        auth: getAuth(req),
        listingId: req.params.listingId,
        groupId: req.params.groupId,
        body: req.body,
      }),
  );

  app.post(
    '/listings/:listingId/groups/:groupId/variants/bulk',
    {
      preHandler: requirePermission('listings.edit'),
      schema: { params: GroupParam, body: BulkCreateGroupVariantsBody },
    },
    async (req) =>
      ctrl.bulkCreateGroupVariants({
        auth: getAuth(req),
        listingId: req.params.listingId,
        groupId: req.params.groupId,
        body: req.body,
      }),
  );

  app.put(
    '/listings/:listingId/default-variant',
    {
      preHandler: requirePermission('listings.edit'),
      schema: { params: ListingIdParam, body: DefaultVariantBody },
    },
    async (req) =>
      ctrl.upsertDefaultVariant({
        auth: getAuth(req),
        listingId: req.params.listingId,
        body: req.body,
      }),
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

  app.post(
    '/listings/:listingId/variants/:vid/publish',
    {
      preHandler: requirePermission('listings.publish'),
      schema: { params: VariantPubParam },
    },
    async (req) =>
      ctrl.publishVariant({
        auth: getAuth(req),
        listingId: req.params.listingId,
        vid: req.params.vid,
      }),
  );

  app.get(
    '/variants/sku-available',
    {
      preHandler: requirePermission('listings.view'),
      schema: { querystring: SkuAvailableQuery },
    },
    async (req) => ctrl.skuAvailable({ auth: getAuth(req), query: req.query }),
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
