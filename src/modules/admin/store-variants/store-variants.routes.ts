import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './store-variants.controller.js';
import {
  BulkCreateBody,
  BulkDeactivateBody,
  CreateVariantBody,
  StoreListingParam,
  StoreParam,
} from './store-variants.validators.js';

const adminStoreVariantsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.post(
    '/:storeId/listings/:listingId/variants',
    {
      preHandler: requirePermission('store_management.edit'),
      schema: { params: StoreListingParam, body: CreateVariantBody },
    },
    async (req) =>
      ctrl.createVariant({
        auth: getAuth(req),
        storeId: req.params.storeId,
        listingId: req.params.listingId,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/:storeId/listings/:listingId/variants/bulk',
    {
      preHandler: requirePermission('store_management.edit'),
      schema: { params: StoreListingParam, body: BulkCreateBody },
    },
    async (req) =>
      ctrl.bulkCreate({
        auth: getAuth(req),
        storeId: req.params.storeId,
        listingId: req.params.listingId,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/:storeId/inventory/bulk-deactivate-variants',
    {
      preHandler: requirePermission('store_management.edit'),
      schema: { params: StoreParam, body: BulkDeactivateBody },
    },
    async (req) =>
      ctrl.bulkDeactivate({
        auth: getAuth(req),
        storeId: req.params.storeId,
        body: req.body,
        requestId: req.id,
      }),
  );
};

export default adminStoreVariantsRoutes;
