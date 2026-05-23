import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './payments.controller.js';
import {
  ContactConsumerBody,
  DiscrepancyParams,
  IdParam,
  ReleaseInventoryBody,
  ResolveDiscrepancyBody,
  SettlementUploadBody,
} from './payments.validators.js';

const adminPaymentsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/payment-failures',
    { preHandler: requirePermission('refunds.view') },
    async () => ctrl.listPaymentFailures(),
  );

  app.post(
    '/payment-failures/:id/contact-consumer',
    {
      preHandler: requirePermission('refunds.view'),
      schema: { params: IdParam, body: ContactConsumerBody },
    },
    async (req) =>
      ctrl.contactConsumer({
        id: req.params.id,
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/payment-failures/:id/release-inventory',
    {
      preHandler: requirePermission('refunds.force'),
      schema: { params: IdParam, body: ReleaseInventoryBody },
    },
    async (req) =>
      ctrl.releaseInventory({
        id: req.params.id,
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
      }),
  );

  app.get(
    '/payment-reconciliation',
    { preHandler: requirePermission('refunds.view') },
    async () => ctrl.listReconciliation(),
  );

  app.post(
    '/payment-reconciliation/upload',
    {
      preHandler: requirePermission('refunds.force'),
      schema: { body: SettlementUploadBody },
    },
    async (req) =>
      ctrl.uploadSettlement({
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
      }),
  );

  app.get(
    '/payment-reconciliation/:id',
    {
      preHandler: requirePermission('refunds.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getSettlement(req.params.id),
  );

  app.post(
    '/payment-reconciliation/:id/rerun',
    {
      preHandler: requirePermission('refunds.force'),
      schema: { params: IdParam },
    },
    async (req) =>
      ctrl.rerunSettlement({
        id: req.params.id,
        auth: getAuth(req),
        requestId: req.id,
      }),
  );

  app.post(
    '/payment-reconciliation/:settlementId/discrepancies/:dId/resolve',
    {
      preHandler: requirePermission('refunds.force'),
      schema: { params: DiscrepancyParams, body: ResolveDiscrepancyBody },
    },
    async (req) =>
      ctrl.resolveDiscrepancy({
        settlementId: req.params.settlementId,
        dId: req.params.dId,
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
      }),
  );
};

export default adminPaymentsRoutes;
