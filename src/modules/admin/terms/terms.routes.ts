import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './terms.controller.js';
import { PublishTermsBody, VersionParam } from './terms.validators.js';

const adminTermsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get('/', { preHandler: requirePermission('platform_config.view') }, async () => ctrl.listTerms());

  app.post(
    '/',
    { preHandler: requirePermission('platform_config.edit'), schema: { body: PublishTermsBody } },
    async (req) => ctrl.publishTerms({ auth: getAuth(req), body: req.body }),
  );

  app.get(
    '/:version/decisions',
    { preHandler: requirePermission('platform_config.view'), schema: { params: VersionParam } },
    async (req) => ctrl.versionDecisions({ params: req.params }),
  );
};

export default adminTermsRoutes;
