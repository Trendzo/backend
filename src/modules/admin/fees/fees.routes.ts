import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './fees.controller.js';
import {
  FeeOverrideBody,
  FeesUpdateBody,
  IdParam,
} from './fees.validators.js';

const adminFeesRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get('/fees', async () => ctrl.getFees());

  app.patch(
    '/fees',
    {
      preHandler: requirePermission('platform_config.edit'),
      schema: { body: FeesUpdateBody },
    },
    async (req) => ctrl.updateFees({ auth: getAuth(req), body: req.body }),
  );

  app.patch(
    '/retailers/:id/fee-override',
    {
      preHandler: requirePermission('store_management.edit'),
      schema: { params: IdParam, body: FeeOverrideBody },
    },
    async (req) =>
      ctrl.setRetailerFeeOverride({
        id: req.params.id,
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
      }),
  );

  app.get('/delivery-windows', async () => ctrl.getDeliveryWindows());
};

export default adminFeesRoutes;
