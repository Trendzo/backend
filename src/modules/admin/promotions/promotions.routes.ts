import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './promotions.controller.js';
import {
  CreateBody,
  GenerateVouchersBody,
  IdParam,
  ListQuery,
  PatchBody,
  PauseBody,
  RevokeBody,
  TargetedDropBody,
} from './promotions.validators.js';

const adminPromotionRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/',
    {
      preHandler: requirePermission('promotions.view'),
      schema: { querystring: ListQuery },
    },
    async (req) => ctrl.listPromotions({ query: req.query }),
  );

  app.get(
    '/:id',
    {
      preHandler: requirePermission('promotions.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getPromotion(req.params.id),
  );

  app.post(
    '/',
    {
      preHandler: requirePermission('promotions.create'),
      schema: { body: CreateBody },
    },
    async (req) => ctrl.createPromotion({ body: req.body }),
  );

  app.patch(
    '/:id',
    {
      preHandler: requirePermission('promotions.create'),
      schema: { params: IdParam, body: PatchBody },
    },
    async (req) => ctrl.patchPromotion({ id: req.params.id, body: req.body }),
  );

  app.post(
    '/:id/pause',
    {
      preHandler: requirePermission('promotions.publish'),
      schema: { params: IdParam, body: PauseBody },
    },
    async (req) =>
      ctrl.pausePromotion({
        auth: getAuth(req),
        id: req.params.id,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/:id/resume',
    {
      preHandler: requirePermission('promotions.publish'),
      schema: { params: IdParam },
    },
    async (req) =>
      ctrl.resumePromotion({ auth: getAuth(req), id: req.params.id, requestId: req.id }),
  );

  app.post(
    '/:id/revoke',
    {
      preHandler: requirePermission('promotions.revoke'),
      schema: { params: IdParam, body: RevokeBody },
    },
    async (req) =>
      ctrl.revokePromotion({
        auth: getAuth(req),
        id: req.params.id,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/:id/activate',
    {
      preHandler: requirePermission('promotions.publish'),
      schema: { params: IdParam },
    },
    async (req) =>
      ctrl.activatePromotion({ auth: getAuth(req), id: req.params.id, requestId: req.id }),
  );

  app.get(
    '/performance',
    { preHandler: requirePermission('promotions.view') },
    async () => ctrl.getPerformance(),
  );

  app.get(
    '/performance/by-mechanism',
    { preHandler: requirePermission('promotions.view') },
    async () => ctrl.getPerformanceByMechanism(),
  );

  app.get(
    '/performance/by-discount-type',
    { preHandler: requirePermission('promotions.view') },
    async () => ctrl.getPerformanceByDiscountType(),
  );

  app.get(
    '/anomalies',
    { preHandler: requirePermission('promotions.view') },
    async () => ctrl.listAnomalies(),
  );

  app.get(
    '/anomalies/:id',
    {
      preHandler: requirePermission('promotions.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getAnomalyById(req.params.id),
  );

  app.get(
    '/targeted-drops',
    { preHandler: requirePermission('promotions.view') },
    async () => ctrl.listTargetedDrops(),
  );

  app.post(
    '/targeted-drops',
    {
      preHandler: requirePermission('promotions.publish'),
      schema: { body: TargetedDropBody },
    },
    async (req) =>
      ctrl.pushTargetedDrop({ auth: getAuth(req), body: req.body, requestId: req.id }),
  );

  app.get(
    '/:id/voucher-codes',
    {
      preHandler: requirePermission('promotions.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.listVoucherCodes({ id: req.params.id }),
  );

  app.post(
    '/:id/voucher-codes/generate',
    {
      preHandler: requirePermission('vouchers.create'),
      schema: { params: IdParam, body: GenerateVouchersBody },
    },
    async (req) => ctrl.generateVoucherCodes({ id: req.params.id, body: req.body }),
  );

  app.get(
    '/:id/voucher-codes/export',
    {
      preHandler: requirePermission('promotions.view'),
      schema: { params: IdParam },
    },
    async (req, reply) => ctrl.exportVoucherCodes({ id: req.params.id, reply }),
  );
};

export default adminPromotionRoutes;
