import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './profile.controller.js';
import { CreateStoreBody, PatchProfileBody } from './profile.validators.js';

const retailerProfileRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  app.get('/me', async (req) => ctrl.getMe({ auth: getAuth(req) }));

  app.post(
    '/store',
    {
      preHandler: requirePermission('store.edit_profile'),
      schema: { body: CreateStoreBody },
    },
    async (req) => ctrl.createStore({ auth: getAuth(req), body: req.body }),
  );

  app.patch(
    '/store/profile',
    {
      preHandler: requirePermission('store.edit_profile'),
      schema: { body: PatchProfileBody },
    },
    async (req) => ctrl.patchStoreProfile({ auth: getAuth(req), body: req.body }),
  );
};

export default retailerProfileRoutes;
