import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './store-promotions.controller.js';
import {
  BulkPauseBody,
  CreatePromotionBody,
  ListPromotionsQuery,
  PatchPromotionBody,
  StoreParam,
  StorePromoParam,
  VoucherGenerateBody,
} from './store-promotions.validators.js';

const adminStorePromotionsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/:storeId/promotions',
    {
      preHandler: requirePermission('promotions.view'),
      schema: { params: StoreParam, querystring: ListPromotionsQuery },
    },
    async (req) => ctrl.listPromotions({ storeId: req.params.storeId, query: req.query }),
  );

  app.get(
    '/:storeId/promotions/:id',
    {
      preHandler: requirePermission('promotions.view'),
      schema: { params: StorePromoParam },
    },
    async (req) =>
      ctrl.getPromotion({ storeId: req.params.storeId, id: req.params.id }),
  );

  app.post(
    '/:storeId/promotions',
    {
      preHandler: requirePermission('promotions.create'),
      schema: { params: StoreParam, body: CreatePromotionBody },
    },
    async (req) =>
      ctrl.createPromotion({
        auth: getAuth(req),
        storeId: req.params.storeId,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.patch(
    '/:storeId/promotions/:id',
    {
      preHandler: requirePermission('promotions.create'),
      schema: { params: StorePromoParam, body: PatchPromotionBody },
    },
    async (req) =>
      ctrl.patchPromotion({
        auth: getAuth(req),
        storeId: req.params.storeId,
        id: req.params.id,
        body: req.body,
        requestId: req.id,
      }),
  );

  for (const verb of ['pause', 'resume', 'revoke', 'activate'] as const) {
    const action = verb === 'revoke' ? 'promotions.revoke' : 'promotions.publish';
    app.post(
      `/:storeId/promotions/:id/${verb}`,
      { preHandler: requirePermission(action), schema: { params: StorePromoParam } },
      async (req) =>
        ctrl.setStatus({
          auth: getAuth(req),
          storeId: req.params.storeId,
          id: req.params.id,
          verb,
          requestId: req.id,
        }),
    );
  }

  app.post(
    '/:storeId/promotions/bulk-pause',
    {
      preHandler: requirePermission('promotions.publish'),
      schema: { params: StoreParam, body: BulkPauseBody },
    },
    async (req) =>
      ctrl.bulkPause({
        auth: getAuth(req),
        storeId: req.params.storeId,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/:storeId/promotions/:id/voucher-codes/generate',
    {
      preHandler: requirePermission('vouchers.create'),
      schema: { params: StorePromoParam, body: VoucherGenerateBody },
    },
    async (req) =>
      ctrl.generateVouchers({
        auth: getAuth(req),
        storeId: req.params.storeId,
        id: req.params.id,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.get(
    '/:storeId/promotions/:id/voucher-codes/export',
    {
      preHandler: requirePermission('promotions.view'),
      schema: { params: StorePromoParam },
    },
    async (req, reply) =>
      ctrl.exportVouchers({
        storeId: req.params.storeId,
        id: req.params.id,
        reply,
      }),
  );

  app.get(
    '/:storeId/pickup-slots',
    {
      preHandler: requirePermission('store_management.view'),
      schema: { params: StoreParam },
    },
    async (req) => ctrl.listPickupSlots({ storeId: req.params.storeId }),
  );
};

export default adminStorePromotionsRoutes;
