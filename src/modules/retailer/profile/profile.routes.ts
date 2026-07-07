import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './profile.controller.js';
import {
  AcceptTermsBody,
  CreateStoreBody,
  DeleteAccountBody,
  PatchProfileBody,
} from './profile.validators.js';

const retailerProfileRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  app.get('/me', async (req) => ctrl.getMe({ auth: getAuth(req) }));

  // Retailer T&C — any authenticated retailer of the store can read; accept records IP + UA.
  app.get('/terms', async (req) => ctrl.getTerms({ auth: getAuth(req) }));
  app.post(
    '/terms/accept',
    { schema: { body: AcceptTermsBody } },
    async (req) =>
      ctrl.acceptTerms({
        auth: getAuth(req),
        body: req.body,
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      }),
  );
  app.post(
    '/terms/decline',
    { schema: { body: AcceptTermsBody } },
    async (req) =>
      ctrl.declineTerms({
        auth: getAuth(req),
        body: req.body,
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      }),
  );

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

  app.delete('/account', { schema: { body: DeleteAccountBody } }, async (req) =>
    ctrl.deleteAccount({ auth: getAuth(req), body: req.body, requestId: req.id }),
  );
};

export default retailerProfileRoutes;
