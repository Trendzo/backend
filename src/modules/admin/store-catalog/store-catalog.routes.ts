import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './store-catalog.controller.js';
import {
  InventoryAdjustBody,
  InventoryListQuery,
  ListListingsQuery,
  OrdersListQuery,
  PatchListingBody,
  PatchVariantBody,
  ReservationsQuery,
  StoreListingParam,
  StoreOrderParam,
  StoreParam,
  StoreVariantParam,
} from './store-catalog.validators.js';

const adminStoreCatalogRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/:storeId/listings',
    {
      preHandler: requirePermission('store_management.view'),
      schema: { params: StoreParam, querystring: ListListingsQuery },
    },
    async (req) => ctrl.listListings({ storeId: req.params.storeId, query: req.query }),
  );

  app.get(
    '/:storeId/listings/:listingId',
    {
      preHandler: requirePermission('store_management.view'),
      schema: { params: StoreListingParam },
    },
    async (req) =>
      ctrl.getListing({ storeId: req.params.storeId, listingId: req.params.listingId }),
  );

  app.patch(
    '/:storeId/listings/:listingId',
    {
      preHandler: requirePermission('store_management.edit'),
      schema: { params: StoreListingParam, body: PatchListingBody },
    },
    async (req) =>
      ctrl.patchListing({
        auth: getAuth(req),
        storeId: req.params.storeId,
        listingId: req.params.listingId,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.patch(
    '/:storeId/variants/:variantId',
    {
      preHandler: requirePermission('store_management.edit'),
      schema: { params: StoreVariantParam, body: PatchVariantBody },
    },
    async (req) =>
      ctrl.patchVariant({
        auth: getAuth(req),
        storeId: req.params.storeId,
        variantId: req.params.variantId,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.get(
    '/:storeId/inventory',
    {
      preHandler: requirePermission('store_management.view'),
      schema: { params: StoreParam, querystring: InventoryListQuery },
    },
    async (req) => ctrl.listInventory({ storeId: req.params.storeId, query: req.query }),
  );

  app.get(
    '/:storeId/inventory/:variantId/reservations',
    {
      preHandler: requirePermission('store_management.view'),
      schema: { params: StoreVariantParam, querystring: ReservationsQuery },
    },
    async (req) =>
      ctrl.listReservations({
        storeId: req.params.storeId,
        variantId: req.params.variantId,
        query: req.query,
      }),
  );

  app.post(
    '/:storeId/inventory/adjust',
    {
      preHandler: requirePermission('inventory.adjust'),
      schema: { params: StoreParam, body: InventoryAdjustBody },
    },
    async (req) =>
      ctrl.inventoryAdjust({
        auth: getAuth(req),
        storeId: req.params.storeId,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.get(
    '/:storeId/orders',
    {
      preHandler: requirePermission('orders.view'),
      schema: { params: StoreParam, querystring: OrdersListQuery },
    },
    async (req) => ctrl.listOrders({ storeId: req.params.storeId, query: req.query }),
  );

  app.get(
    '/:storeId/orders/:orderId',
    {
      preHandler: requirePermission('orders.view'),
      schema: { params: StoreOrderParam },
    },
    async (req) =>
      ctrl.getOrder({ storeId: req.params.storeId, orderId: req.params.orderId }),
  );
};

export default adminStoreCatalogRoutes;
