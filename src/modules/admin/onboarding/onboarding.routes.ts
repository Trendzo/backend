import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './onboarding.controller.js';
import {
  ApproveBody,
  IdParam,
  ListApplicationsQuery,
  MessageBody,
  RejectBody,
  UpdateStatusBody,
  VerificationCheckBody,
} from './onboarding.validators.js';

const adminOnboardingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/applications',
    {
      preHandler: requirePermission('applications.view'),
      schema: { querystring: ListApplicationsQuery },
    },
    async (req) => ctrl.listApplications({ query: req.query }),
  );

  app.get(
    '/applications/:id',
    {
      preHandler: requirePermission('applications.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getApplication(req.params.id),
  );

  app.patch(
    '/applications/:id/status',
    {
      preHandler: requirePermission('applications.message'),
      schema: { params: IdParam, body: UpdateStatusBody },
    },
    async (req) =>
      ctrl.updateApplicationStatus({
        id: req.params.id,
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/applications/:id/approve',
    {
      preHandler: requirePermission('retailer.approve'),
      schema: { params: IdParam, body: ApproveBody },
    },
    async (req) =>
      ctrl.approveApplication({
        id: req.params.id,
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
        log: req.log,
      }),
  );

  app.post(
    '/applications/:id/reject',
    {
      preHandler: requirePermission('retailer.reject'),
      schema: { params: IdParam, body: RejectBody },
    },
    async (req) =>
      ctrl.rejectApplication({
        id: req.params.id,
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/applications/:id/messages',
    {
      preHandler: requirePermission('applications.message'),
      schema: { params: IdParam, body: MessageBody },
    },
    async (req) =>
      ctrl.postMessage({
        id: req.params.id,
        auth: getAuth(req),
        body: req.body,
      }),
  );

  app.post(
    '/applications/:id/verification-checks',
    {
      preHandler: requirePermission('applications.message'),
      schema: { params: IdParam, body: VerificationCheckBody },
    },
    async (req) =>
      ctrl.recordVerificationCheck({
        id: req.params.id,
        body: req.body,
      }),
  );
};

export default adminOnboardingRoutes;
