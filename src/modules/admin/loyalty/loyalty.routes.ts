import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './loyalty.controller.js';
import {
  ConsumerSearchQuery,
  IdParam,
  LoyaltyAdjustBody,
  LoyaltyConfigUpdateSchema,
  WalletAdjustBody,
} from './loyalty.validators.js';

const adminLoyaltyRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/config',
    { preHandler: requirePermission('loyalty.view') },
    async () => ctrl.getConfig(),
  );

  app.patch(
    '/config',
    {
      preHandler: requirePermission('loyalty.adjust'),
      schema: { body: LoyaltyConfigUpdateSchema },
    },
    async (req) => ctrl.patchConfig({ auth: getAuth(req), body: req.body }),
  );

  app.get(
    '/consumers',
    {
      preHandler: requirePermission('consumers.view'),
      schema: { querystring: ConsumerSearchQuery },
    },
    async (req) => ctrl.searchConsumers({ query: req.query }),
  );

  app.get(
    '/consumers/:id/wallet',
    {
      preHandler: requirePermission('consumers.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getWallet(req.params.id),
  );

  app.post(
    '/consumers/:id/wallet/adjust',
    {
      preHandler: requirePermission('loyalty.adjust'),
      schema: { params: IdParam, body: WalletAdjustBody },
    },
    async (req) => ctrl.adjustWallet({ id: req.params.id, body: req.body }),
  );

  app.get(
    '/consumers/:id/loyalty',
    {
      preHandler: requirePermission('loyalty.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getLoyalty(req.params.id),
  );

  app.post(
    '/consumers/:id/loyalty/adjust',
    {
      preHandler: requirePermission('loyalty.adjust'),
      schema: { params: IdParam, body: LoyaltyAdjustBody },
    },
    async (req) => ctrl.adjustLoyalty({ id: req.params.id, body: req.body }),
  );
};

export default adminLoyaltyRoutes;
