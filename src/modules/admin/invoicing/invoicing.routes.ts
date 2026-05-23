import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './invoicing.controller.js';
import {
  GenerateGstReturnBody,
  IssueCommissionInvoiceBody,
  IssueCreditNoteBody,
  IssueInvoiceBody,
  LegalEntityParam,
  UpdateNumberingBody,
} from './invoicing.validators.js';

const adminInvoicingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/invoice-numbering',
    { preHandler: requirePermission('invoicing.numbering.edit') },
    async () => ctrl.listInvoiceNumbering(),
  );

  app.put(
    '/invoice-numbering/:legalEntityId',
    {
      preHandler: requirePermission('invoicing.numbering.edit'),
      schema: { params: LegalEntityParam, body: UpdateNumberingBody },
    },
    async (req) =>
      ctrl.updateInvoiceNumbering({
        legalEntityId: req.params.legalEntityId,
        body: req.body,
      }),
  );

  app.get(
    '/gst-returns',
    { preHandler: requirePermission('invoicing.gst_returns.generate') },
    async () => ctrl.listGstReturns(),
  );

  app.post(
    '/gst-returns/generate',
    {
      preHandler: requirePermission('invoicing.gst_returns.generate'),
      schema: { body: GenerateGstReturnBody },
    },
    async (req) => ctrl.generateGstReturn({ body: req.body }),
  );

  app.post(
    '/invoices/issue',
    {
      preHandler: requirePermission('invoicing.numbering.edit'),
      schema: { body: IssueInvoiceBody },
    },
    async (req) => ctrl.issueInvoiceManual({ body: req.body }),
  );

  app.post(
    '/credit-notes/issue',
    {
      preHandler: requirePermission('invoicing.numbering.edit'),
      schema: { body: IssueCreditNoteBody },
    },
    async (req) => ctrl.issueCreditNoteManual({ body: req.body }),
  );

  app.post(
    '/invoices/commission/issue',
    {
      preHandler: requirePermission('invoicing.numbering.edit'),
      schema: { body: IssueCommissionInvoiceBody },
    },
    async (req) => ctrl.issueCommissionInvoiceManual({ body: req.body }),
  );
};

export default adminInvoicingRoutes;
