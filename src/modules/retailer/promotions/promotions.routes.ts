import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './promotions.controller.js';
import {
  CreateBody,
  ExportVouchersQuery,
  GenerateVouchersBody,
  IdParam,
  ListQuery,
  PatchBody,
  PauseBody,
  RevokeBody,
  ScopeListingBody,
} from './promotions.validators.js';

const retailerPromotionRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  app.get(
    '/delegation-modes',
    { preHandler: requirePermission('promotions.view') },
    async () => ctrl.getDelegationModes(),
  );

  app.get(
    '/clubbing-policy',
    { preHandler: requirePermission('promotions.view') },
    async () => ctrl.getClubbingPolicy(),
  );

  app.get(
    '/',
    {
      preHandler: requirePermission('promotions.view'),
      schema: { querystring: ListQuery },
    },
    async (req) => ctrl.listPromotions({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/:id',
    {
      preHandler: requirePermission('promotions.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getPromotion({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/',
    {
      preHandler: requirePermission('promotions.create'),
      schema: { body: CreateBody },
    },
    async (req) => ctrl.createPromotion({ auth: getAuth(req), body: req.body }),
  );

  app.patch(
    '/:id',
    {
      preHandler: requirePermission('promotions.edit'),
      schema: { params: IdParam, body: PatchBody },
    },
    async (req) =>
      ctrl.patchPromotion({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );

  app.patch(
    '/:id/scope/listing',
    {
      preHandler: requirePermission('promotions.edit'),
      schema: { params: IdParam, body: ScopeListingBody },
    },
    async (req) =>
      ctrl.patchScopeListing({ auth: getAuth(req), id: req.params.id, body: req.body }),
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

  app.post(
    '/voucher-codes/generate',
    {
      preHandler: requirePermission('vouchers.generate'),
      schema: { body: GenerateVouchersBody },
    },
    async (req) => ctrl.generateVouchers({ auth: getAuth(req), body: req.body }),
  );

  app.get(
    '/voucher-codes/export',
    {
      preHandler: requirePermission('vouchers.view'),
      schema: { querystring: ExportVouchersQuery },
    },
    async (req, reply) =>
      ctrl.exportVouchers({ auth: getAuth(req), query: req.query, reply }),
  );

  app.get(
    '/performance',
    { preHandler: requirePermission('promotions.view') },
    async (req) => ctrl.getPerformance({ auth: getAuth(req) }),
  );
};

export default retailerPromotionRoutes;
