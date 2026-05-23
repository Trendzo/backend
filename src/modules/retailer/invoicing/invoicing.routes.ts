import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './invoicing.controller.js';
import { IdParam, ListInvoicesQuery } from './invoicing.validators.js';

const retailerInvoicingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  app.get(
    '/invoices',
    {
      preHandler: requirePermission('invoicing.view'),
      schema: { querystring: ListInvoicesQuery },
    },
    async (req) => ctrl.listInvoices({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/invoices/:id',
    {
      preHandler: requirePermission('invoicing.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getInvoice({ auth: getAuth(req), id: req.params.id }),
  );

  app.get(
    '/invoices/:id/pdf',
    {
      preHandler: requirePermission('invoicing.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getInvoicePdf({ auth: getAuth(req), id: req.params.id }),
  );
};

export default retailerInvoicingRoutes;
