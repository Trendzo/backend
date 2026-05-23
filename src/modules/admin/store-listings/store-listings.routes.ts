import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './store-listings.controller.js';
import {
  BulkDeleteBody,
  BulkStatusBody,
  CreateListingBody,
  StoreListingParam,
  StoreParam,
} from './store-listings.validators.js';

const adminStoreListingsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.post(
    '/:storeId/listings',
    {
      preHandler: requirePermission('store_management.edit'),
      schema: { params: StoreParam, body: CreateListingBody },
    },
    async (req) =>
      ctrl.createListing({
        auth: getAuth(req),
        storeId: req.params.storeId,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.delete(
    '/:storeId/listings/:listingId',
    {
      preHandler: requirePermission('store_management.edit'),
      schema: { params: StoreListingParam },
    },
    async (req) =>
      ctrl.deleteListing({
        auth: getAuth(req),
        storeId: req.params.storeId,
        listingId: req.params.listingId,
        requestId: req.id,
      }),
  );

  app.post(
    '/:storeId/listings/bulk-status',
    {
      preHandler: requirePermission('store_management.edit'),
      schema: { params: StoreParam, body: BulkStatusBody },
    },
    async (req) =>
      ctrl.bulkStatus({
        auth: getAuth(req),
        storeId: req.params.storeId,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/:storeId/listings/bulk-delete',
    {
      preHandler: requirePermission('store_management.edit'),
      schema: { params: StoreParam, body: BulkDeleteBody },
    },
    async (req) =>
      ctrl.bulkDelete({
        auth: getAuth(req),
        storeId: req.params.storeId,
        body: req.body,
        requestId: req.id,
      }),
  );
};

export default adminStoreListingsRoutes;
