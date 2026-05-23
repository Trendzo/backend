import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './wallet.controller.js';
import { IdParam, ListWalletPayoutsQuery } from './wallet.validators.js';

const adminWalletRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/wallet-payouts',
    {
      preHandler: requirePermission('wallet_payouts.process'),
      schema: { querystring: ListWalletPayoutsQuery },
    },
    async (req) => ctrl.listWalletPayouts({ query: req.query }),
  );

  app.post(
    '/wallet-payouts/:id/disburse',
    {
      preHandler: requirePermission('wallet_payouts.process'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.disburseWalletPayout(req.params.id),
  );

  app.post(
    '/wallet-payouts/:id/escheat',
    {
      preHandler: requirePermission('wallet_payouts.process'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.escheatWalletPayout(req.params.id),
  );
};

export default adminWalletRoutes;
