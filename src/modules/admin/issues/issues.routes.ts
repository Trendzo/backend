import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './issues.controller.js';
import {
  AddMessageBody,
  AssignBody,
  BulkCloseBody,
  ChangeKindBody,
  CreateIssueBody,
  DecideBody,
  EscalateBody,
  FlagPartyBody,
  IdParam,
  ListIssuesQuery,
  RequestEvidenceBody,
} from './issues.validators.js';

const adminIssuesRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/issues',
    {
      preHandler: requirePermission('disputes.view'),
      schema: { querystring: ListIssuesQuery },
    },
    async (req) => ctrl.listIssues({ query: req.query }),
  );

  app.get(
    '/issues/:id',
    {
      preHandler: requirePermission('disputes.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getIssue({ id: req.params.id }),
  );

  app.post(
    '/issues',
    {
      preHandler: requirePermission('disputes.decide'),
      schema: { body: CreateIssueBody },
    },
    async (req) => ctrl.postIssue({ body: req.body, auth: getAuth(req) }),
  );

  app.post(
    '/issues/:id/messages',
    {
      preHandler: requirePermission('disputes.decide'),
      schema: { params: IdParam, body: AddMessageBody },
    },
    async (req) => ctrl.postMessage({ id: req.params.id, body: req.body, auth: getAuth(req) }),
  );

  app.post(
    '/issues/:id/assign',
    {
      preHandler: requirePermission('disputes.decide'),
      schema: { params: IdParam, body: AssignBody },
    },
    async (req) => ctrl.postAssign({ id: req.params.id, body: req.body, auth: getAuth(req) }),
  );

  app.post(
    '/issues/:id/request-evidence',
    {
      preHandler: requirePermission('disputes.decide'),
      schema: { params: IdParam, body: RequestEvidenceBody },
    },
    async (req) =>
      ctrl.postRequestEvidence({ id: req.params.id, body: req.body, auth: getAuth(req) }),
  );

  app.post(
    '/issues/:id/decide',
    {
      preHandler: requirePermission('disputes.decide'),
      schema: { params: IdParam, body: DecideBody },
    },
    async (req) => ctrl.postDecide({ id: req.params.id, body: req.body, auth: getAuth(req) }),
  );

  app.post(
    '/issues/:id/escalate',
    {
      preHandler: requirePermission('disputes.decide'),
      schema: { params: IdParam, body: EscalateBody },
    },
    async (req) => ctrl.postEscalate({ id: req.params.id, body: req.body, auth: getAuth(req) }),
  );

  app.post(
    '/issues/:id/close',
    {
      preHandler: requirePermission('disputes.decide'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.postClose({ id: req.params.id, auth: getAuth(req) }),
  );

  app.post(
    '/issues/:id/change-kind',
    {
      preHandler: requirePermission('disputes.decide'),
      schema: { params: IdParam, body: ChangeKindBody },
    },
    async (req) =>
      ctrl.postChangeKind({ id: req.params.id, body: req.body, auth: getAuth(req) }),
  );

  app.post(
    '/issues/:id/flag-party',
    {
      preHandler: requirePermission('disputes.decide'),
      schema: { params: IdParam, body: FlagPartyBody },
    },
    async (req) =>
      ctrl.postFlagParty({ id: req.params.id, body: req.body, auth: getAuth(req) }),
  );

  app.get(
    '/issues-workload',
    { preHandler: requirePermission('disputes.view') },
    async () => ctrl.getWorkload(),
  );

  app.get(
    '/issues-counts',
    { preHandler: requirePermission('disputes.view') },
    async () => ctrl.getCounts(),
  );

  app.post(
    '/issues/bulk-close',
    {
      preHandler: requirePermission('disputes.decide'),
      schema: { body: BulkCloseBody },
    },
    async (req) => ctrl.postBulkClose({ body: req.body, auth: getAuth(req) }),
  );
};

export default adminIssuesRoutes;
