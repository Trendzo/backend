import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './compliance.controller.js';
import {
  ChangeRequestBody,
  IdParam,
  KycUploadBody,
} from './compliance.validators.js';

const retailerComplianceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  app.get(
    '/kyc',
    { preHandler: requirePermission('compliance.view') },
    async (req) => ctrl.getKyc({ auth: getAuth(req) }),
  );

  app.post(
    '/kyc/:id/submit',
    { preHandler: requirePermission('kyc.respond'), schema: { params: IdParam } },
    async (req) => ctrl.submitKyc({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/kyc/:id/documents',
    {
      preHandler: requirePermission('kyc.respond'),
      schema: { params: IdParam, body: KycUploadBody },
    },
    async (req) =>
      ctrl.uploadKycDocument({
        auth: getAuth(req),
        id: req.params.id,
        body: req.body,
      }),
  );

  app.get(
    '/change-requests',
    { preHandler: requirePermission('change_requests.view') },
    async (req) => ctrl.listChangeRequests({ auth: getAuth(req) }),
  );

  app.get(
    '/change-requests/current-values',
    { preHandler: requirePermission('change_requests.view') },
    async (req) => ctrl.getCurrentValues({ auth: getAuth(req) }),
  );

  app.post(
    '/change-requests',
    {
      preHandler: requirePermission('change_requests.submit'),
      schema: { body: ChangeRequestBody },
    },
    async (req) =>
      ctrl.submitChangeRequest({ auth: getAuth(req), body: req.body }),
  );

  app.get(
    '/compliance/policy-enforcement',
    { preHandler: requirePermission('compliance.view') },
    async (req) => ctrl.listPolicyEnforcement({ auth: getAuth(req) }),
  );
};

export default retailerComplianceRoutes;
