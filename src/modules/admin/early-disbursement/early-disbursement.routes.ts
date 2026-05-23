import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './early-disbursement.controller.js';
import {
  IdParam,
  ListDecisionsQuery,
  RejectBody,
} from './early-disbursement.validators.js';

const adminEarlyDisbursementRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/early-disbursement-decisions',
    {
      preHandler: requirePermission('early_disbursement.decide'),
      schema: { querystring: ListDecisionsQuery },
    },
    async (req) => ctrl.listDecisions({ query: req.query }),
  );

  app.post(
    '/early-disbursement-decisions/:id/approve',
    {
      preHandler: requirePermission('early_disbursement.decide'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.approveDecision({ id: req.params.id, auth: getAuth(req) }),
  );

  app.post(
    '/early-disbursement-decisions/:id/reject',
    {
      preHandler: requirePermission('early_disbursement.decide'),
      schema: { params: IdParam, body: RejectBody },
    },
    async (req) =>
      ctrl.rejectDecision({
        id: req.params.id,
        auth: getAuth(req),
        body: req.body,
      }),
  );

  app.post(
    '/early-disbursement-decisions/:id/execute',
    {
      preHandler: requirePermission('early_disbursement.decide'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.executeDecision({ id: req.params.id, auth: getAuth(req) }),
  );
};

export default adminEarlyDisbursementRoutes;
