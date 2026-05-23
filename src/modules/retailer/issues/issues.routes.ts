import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './issues.controller.js';
import {
  AddMessageBody,
  CreateIssueBody,
  IdParam,
  ListIssuesQuery,
} from './issues.validators.js';

const retailerIssuesRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  app.get(
    '/issues',
    {
      preHandler: requirePermission('disputes.view'),
      schema: { querystring: ListIssuesQuery },
    },
    async (req) => ctrl.listIssues({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/issues/:id',
    {
      preHandler: requirePermission('disputes.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getIssue({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/issues',
    {
      preHandler: requirePermission('issues.create'),
      schema: { body: CreateIssueBody },
    },
    async (req) => ctrl.postIssue({ auth: getAuth(req), body: req.body }),
  );

  app.post(
    '/issues/:id/messages',
    {
      preHandler: requirePermission('disputes.respond'),
      schema: { params: IdParam, body: AddMessageBody },
    },
    async (req) => ctrl.postMessage({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );

  app.post(
    '/issues/:id/hand-back',
    {
      preHandler: requirePermission('disputes.respond'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.postHandBack({ auth: getAuth(req), id: req.params.id }),
  );
};

export default retailerIssuesRoutes;
