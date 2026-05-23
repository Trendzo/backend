import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './vouchers.controller.js';
import {
  BulkGenerateBody,
  DistributeBody,
  FormatQuery,
  PromotionIdParam,
} from './vouchers.validators.js';

const adminVoucherRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/:promotionId/vouchers',
    {
      preHandler: requirePermission('promotions.view'),
      schema: { params: PromotionIdParam, querystring: FormatQuery },
    },
    async (req, reply) =>
      ctrl.listVouchers({
        promotionId: req.params.promotionId,
        query: req.query,
        reply,
      }),
  );

  app.post(
    '/:promotionId/vouchers/bulk-generate',
    {
      preHandler: requirePermission('vouchers.create'),
      schema: { params: PromotionIdParam, body: BulkGenerateBody },
    },
    async (req) =>
      ctrl.bulkGenerate({
        promotionId: req.params.promotionId,
        body: req.body,
      }),
  );

  app.post(
    '/:promotionId/vouchers/distribute-to',
    {
      preHandler: requirePermission('vouchers.create'),
      schema: { params: PromotionIdParam, body: DistributeBody },
    },
    async () => ctrl.distributeStub(),
  );
};

export default adminVoucherRoutes;
