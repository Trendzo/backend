import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './disputes.controller.js';
import {
  DecideBody,
  EscalateBody,
  IdParam,
  ListDisputesQuery,
  OpenDisputeBody,
  RequestEvidenceBody,
} from './disputes.validators.js';

const adminDisputeRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.post(
    '/disputes',
    {
      preHandler: requirePermission('disputes.decide'),
      schema: { body: OpenDisputeBody },
    },
    async (req) => ctrl.openDispute({ body: req.body }),
  );

  app.get(
    '/disputes',
    {
      preHandler: requirePermission('disputes.view'),
      schema: { querystring: ListDisputesQuery },
    },
    async (req) => ctrl.listDisputes({ query: req.query }),
  );

  app.get(
    '/disputes/:id',
    {
      preHandler: requirePermission('disputes.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getDispute(req.params.id),
  );

  app.post(
    '/disputes/:id/request-evidence',
    {
      preHandler: requirePermission('disputes.decide'),
      schema: { params: IdParam, body: RequestEvidenceBody },
    },
    async (req) => ctrl.requestEvidence({ id: req.params.id, body: req.body }),
  );

  app.post(
    '/disputes/:id/decide',
    {
      preHandler: requirePermission('disputes.decide'),
      schema: { params: IdParam, body: DecideBody },
    },
    async (req) =>
      ctrl.decideDispute({
        id: req.params.id,
        auth: getAuth(req),
        body: req.body,
      }),
  );

  app.post(
    '/disputes/:id/escalate',
    {
      preHandler: requirePermission('disputes.decide'),
      schema: { params: IdParam, body: EscalateBody },
    },
    async (req) => ctrl.escalateDispute({ id: req.params.id, body: req.body }),
  );
};

export default adminDisputeRoutes;
