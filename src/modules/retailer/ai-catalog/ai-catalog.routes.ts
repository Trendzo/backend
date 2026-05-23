import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './ai-catalog.controller.js';
import {
  AcceptBody,
  GenerateBody,
  IdParam,
  ListQuery,
  QuotaQuery,
  RegenerateBody,
} from './ai-catalog.validators.js';

const aiCatalogRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  app.get(
    '/ai-catalog',
    {
      preHandler: requirePermission('ai_catalog.generate'),
      schema: { querystring: ListQuery },
    },
    async (req) => ctrl.listSubmissions({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/ai-catalog/quota',
    {
      preHandler: requirePermission('ai_catalog.generate'),
      schema: { querystring: QuotaQuery },
    },
    async (req) => ctrl.getQuota({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/ai-catalog/:id',
    {
      preHandler: requirePermission('ai_catalog.generate'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getSubmission({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/ai-catalog',
    {
      preHandler: requirePermission('ai_catalog.generate'),
      schema: { body: GenerateBody },
    },
    async (req) => ctrl.createSubmission({ auth: getAuth(req), body: req.body }),
  );

  app.post(
    '/ai-catalog/:id/regenerate',
    {
      preHandler: requirePermission('ai_catalog.generate'),
      schema: { params: IdParam, body: RegenerateBody },
    },
    async (req) =>
      ctrl.regenerateSubmission({
        auth: getAuth(req),
        id: req.params.id,
        body: req.body,
      }),
  );

  app.post(
    '/ai-catalog/:id/accept',
    {
      preHandler: requirePermission('ai_catalog.generate'),
      schema: { params: IdParam, body: AcceptBody },
    },
    async (req) =>
      ctrl.acceptSubmission({
        auth: getAuth(req),
        id: req.params.id,
        body: req.body,
      }),
  );

  app.post(
    '/ai-catalog/:id/reject',
    {
      preHandler: requirePermission('ai_catalog.generate'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.rejectSubmission({ auth: getAuth(req), id: req.params.id }),
  );
};

export default aiCatalogRoutes;
