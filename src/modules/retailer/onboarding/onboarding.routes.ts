import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './onboarding.controller.js';
import {
  CheckIdentityQuery,
  FetchForResubmitBody,
  IdParam,
  MessagesQuery,
  PostMessageBody,
  ResubmitBody,
  StatusQuery,
  SubmitApplicationBody,
} from './onboarding.validators.js';

/**
 * Public application submission — no auth required. Applicant fills the form
 * before any account exists. The auth'd retailer message route is the exception.
 */
const retailerOnboardingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/applications',
    { schema: { body: SubmitApplicationBody } },
    async (req) => ctrl.submitApplication({ body: req.body }),
  );

  app.get(
    '/applications/:id/status',
    { schema: { params: IdParam, querystring: StatusQuery } },
    async (req) =>
      ctrl.getApplicationStatus({ id: req.params.id, query: req.query }),
  );

  app.get(
    '/applications/check-identity',
    { schema: { querystring: CheckIdentityQuery } },
    async (req) => ctrl.checkIdentity({ query: req.query }),
  );

  app.get(
    '/applications/:id/messages',
    { schema: { params: IdParam, querystring: MessagesQuery } },
    async (req) =>
      ctrl.getPublicMessages({ id: req.params.id, query: req.query }),
  );

  app.get(
    '/application/messages',
    { preHandler: requireAuth('retailer') },
    async (req) => ctrl.getOwnApplicationMessages({ auth: getAuth(req) }),
  );

  app.post(
    '/applications/:id/messages',
    { schema: { params: IdParam, body: PostMessageBody } },
    async (req) => ctrl.postPublicMessage({ id: req.params.id, body: req.body }),
  );

  app.post(
    '/applications/:id/fetch-for-resubmit',
    { schema: { params: IdParam, body: FetchForResubmitBody } },
    async (req) => ctrl.fetchForResubmit({ id: req.params.id, body: req.body }),
  );

  app.post(
    '/applications/:id/resubmit',
    { schema: { params: IdParam, body: ResubmitBody } },
    async (req) =>
      ctrl.resubmitApplication({
        id: req.params.id,
        body: req.body,
        requestId: req.id,
      }),
  );
};

export default retailerOnboardingRoutes;
