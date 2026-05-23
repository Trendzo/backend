import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './issues.controller.js';
import {
  AddMessageBody,
  CreateIssueBody,
  IdParam,
  ListIssuesQuery,
} from './issues.validators.js';

const consumerIssuesRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('consumer'));

  app.get(
    '/',
    { schema: { querystring: ListIssuesQuery } },
    async (req) => ctrl.listIssues({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/:id',
    { schema: { params: IdParam } },
    async (req) => ctrl.getIssue({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/',
    { schema: { body: CreateIssueBody } },
    async (req) => ctrl.postIssue({ auth: getAuth(req), body: req.body }),
  );

  app.post(
    '/:id/messages',
    { schema: { params: IdParam, body: AddMessageBody } },
    async (req) => ctrl.postMessage({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );
};

export default consumerIssuesRoutes;
