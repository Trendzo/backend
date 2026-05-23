import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './platform.controller.js';
import { CapabilityParam, ModeBody } from './platform.validators.js';

const adminPlatformRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get('/delegation-modes', async () => ctrl.getDelegationModes());

  app.patch(
    '/delegation-modes/:capability',
    { schema: { params: CapabilityParam, body: ModeBody } },
    async (req) =>
      ctrl.setDelegationMode({ capability: req.params.capability, body: req.body }),
  );
};

export default adminPlatformRoutes;
