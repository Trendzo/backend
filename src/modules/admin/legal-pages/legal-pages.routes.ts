import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './legal-pages.controller.js';
import { AppParam, UpdatePolicyBody } from './legal-pages.validators.js';

/**
 * Admin CMS for the per-app privacy policies served at /privacy/:app. Reads/writes
 * gated on the existing legal-config permission (same family as /admin/terms), so it's
 * super-admin territory rather than general CMS editors.
 */
const adminLegalPagesRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get('/privacy', { preHandler: requirePermission('platform_config.view') }, async () =>
    ctrl.listPolicies(),
  );

  app.get(
    '/privacy/:app',
    { preHandler: requirePermission('platform_config.view'), schema: { params: AppParam } },
    async (req) => ctrl.getPolicy({ app: req.params.app }),
  );

  app.put(
    '/privacy/:app',
    {
      preHandler: requirePermission('platform_config.edit'),
      schema: { params: AppParam, body: UpdatePolicyBody },
    },
    async (req) => ctrl.updatePolicy({ auth: getAuth(req), app: req.params.app, body: req.body }),
  );
};

export default adminLegalPagesRoutes;
