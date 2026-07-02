import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './ai-catalog-beta.controller.js';
import {
  DecisionBody,
  IdParam,
  ListQuery,
  PublishBody,
  SubmissionBody,
} from './ai-catalog-beta.validators.js';

/**
 * BETA AI-catalog flow (product-LAST): generate a multi-angle set from uploaded
 * apparel (+ optional design) -> approve/deny -> add product details -> create
 * a product. Coexists with the legacy product-FIRST ai-catalog module.
 */
const aiCatalogBetaRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  app.get(
    '/ai-catalog-beta/submissions',
    {
      preHandler: requirePermission('ai_catalog.generate'),
      schema: { querystring: ListQuery },
    },
    async (req) => ctrl.listSubmissions({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/ai-catalog-beta/submissions/:id',
    {
      preHandler: requirePermission('ai_catalog.generate'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getSubmission({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/ai-catalog-beta/submissions',
    {
      preHandler: requirePermission('ai_catalog.generate'),
      schema: { body: SubmissionBody },
    },
    async (req) => ctrl.createSubmission({ auth: getAuth(req), body: req.body }),
  );

  app.post(
    '/ai-catalog-beta/submissions/:id/decision',
    {
      preHandler: requirePermission('ai_catalog.generate'),
      schema: { params: IdParam, body: DecisionBody },
    },
    async (req) =>
      ctrl.decide({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );

  app.post(
    '/ai-catalog-beta/submissions/:id/publish',
    {
      preHandler: requirePermission('listings.create'),
      schema: { params: IdParam, body: PublishBody },
    },
    async (req) =>
      ctrl.publish({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );
};

export default aiCatalogBetaRoutes;
