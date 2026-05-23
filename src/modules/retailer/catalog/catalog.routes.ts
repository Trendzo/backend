import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './catalog.controller.js';
import {
  CreateTemplateBody,
  IdParam,
  PatchTemplateBody,
} from './catalog.validators.js';

const retailerCatalogRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  app.get(
    '/attribute-templates',
    { preHandler: requirePermission('attribute_templates.view') },
    async (req) => ctrl.listTemplates({ auth: getAuth(req) }),
  );

  app.get(
    '/attribute-templates/:id',
    {
      preHandler: requirePermission('attribute_templates.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getTemplate({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/attribute-templates',
    {
      preHandler: requirePermission('attribute_templates.edit'),
      schema: { body: CreateTemplateBody },
    },
    async (req) => ctrl.createTemplate({ auth: getAuth(req), body: req.body }),
  );

  app.patch(
    '/attribute-templates/:id',
    {
      preHandler: requirePermission('attribute_templates.edit'),
      schema: { params: IdParam, body: PatchTemplateBody },
    },
    async (req) =>
      ctrl.patchTemplate({
        auth: getAuth(req),
        id: req.params.id,
        body: req.body,
      }),
  );

  app.delete(
    '/attribute-templates/:id',
    {
      preHandler: requirePermission('attribute_templates.edit'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.deleteTemplate({ auth: getAuth(req), id: req.params.id }),
  );
};

export default retailerCatalogRoutes;
