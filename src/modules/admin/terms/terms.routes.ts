import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './terms.controller.js';
import { ListTermsQuery, PublishTermsBody, VersionParam } from './terms.validators.js';

const adminTermsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // ?kind=terms (default) | privacy — one endpoint serves both legal documents.
  app.get(
    '/',
    { preHandler: requirePermission('platform_config.view'), schema: { querystring: ListTermsQuery } },
    async (req) => ctrl.listTerms({ query: req.query }),
  );

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
