import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './compliance.controller.js';
import {
  AdminChangeRequestBody,
  ChangeRequestDecideBody,
  ChangeRequestStatusQuery,
  DataExportProcessBody,
  DeletionCancelBody,
  IdParam,
  KycDecideBody,
  PolicyEnforcementBody,
  PolicyEnforcementQuery,
  ReverifyBody,
  StoreIdParam,
} from './compliance.validators.js';

const adminComplianceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/compliance/kyc',
    { preHandler: requirePermission('kyc.review') },
    async () => ctrl.listKycCycles(),
  );

  app.get(
    '/compliance/kyc/:id',
    {
      preHandler: requirePermission('kyc.review'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getKycCycle(req.params.id),
  );

  app.post(
    '/compliance/kyc/:id/decide',
    {
      preHandler: requirePermission('kyc.decide'),
      schema: { params: IdParam, body: KycDecideBody },
    },
    async (req) =>
      ctrl.decideKyc({
        id: req.params.id,
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
      }),
  );

  app.get(
    '/compliance/change-requests',
    {
      preHandler: requirePermission('change_requests.view'),
      schema: { querystring: ChangeRequestStatusQuery },
    },
    async (req) => ctrl.listChangeRequests({ query: req.query }),
  );

  app.get(
    '/compliance/change-requests/:id',
    {
      preHandler: requirePermission('change_requests.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getChangeRequest(req.params.id),
  );

  app.post(
    '/compliance/change-requests/:id/decide',
    {
      preHandler: requirePermission('change_requests.decide'),
      schema: { params: IdParam, body: ChangeRequestDecideBody },
    },
    async (req) =>
      ctrl.decideChangeRequest({
        id: req.params.id,
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
      }),
  );

  // Admin files a change request on behalf of a store (the "with change request"
  // edit path from store-detail). Store-scoped since change_requests.storeId.
  app.post(
    '/compliance/stores/:storeId/change-requests',
    {
      preHandler: requirePermission('store_management.edit'),
      schema: { params: StoreIdParam, body: AdminChangeRequestBody },
    },
    async (req) =>
      ctrl.createChangeRequest({
        storeId: req.params.storeId,
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
      }),
  );

  app.get(
    '/compliance/policy-enforcement',
    {
      preHandler: requirePermission('moderation.view'),
      schema: { querystring: PolicyEnforcementQuery },
    },
    async (req) => ctrl.listPolicyEnforcement({ query: req.query }),
  );

  app.post(
    '/compliance/policy-enforcement',
    {
      preHandler: requirePermission('policy_enforcement.create'),
      schema: { body: PolicyEnforcementBody },
    },
    async (req) =>
      ctrl.createPolicyEnforcement({
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/compliance/stores/:storeId/reverify',
    {
      preHandler: requirePermission('kyc.review'),
      schema: { params: StoreIdParam, body: ReverifyBody },
    },
    async (req) =>
      ctrl.triggerReverify({
        storeId: req.params.storeId,
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
      }),
  );

  app.get(
    '/compliance/data-exports',
    { preHandler: requirePermission('data_exports.manage') },
    async () => ctrl.listDataExports(),
  );

  app.post(
    '/compliance/data-exports/:id/process',
    {
      preHandler: requirePermission('data_exports.manage'),
      schema: { params: IdParam, body: DataExportProcessBody },
    },
    async (req) => ctrl.processDataExport({ id: req.params.id, body: req.body }),
  );

  app.get(
    '/compliance/account-deletions',
    { preHandler: requirePermission('account_deletions.manage') },
    async () => ctrl.listAccountDeletions(),
  );

  app.post(
    '/compliance/account-deletions/:id/complete',
    {
      preHandler: requirePermission('account_deletions.manage'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.completeAccountDeletion(req.params.id),
  );

  app.post(
    '/compliance/account-deletions/:id/cancel',
    {
      preHandler: requirePermission('account_deletions.manage'),
      schema: { params: IdParam, body: DeletionCancelBody },
    },
    async (req) =>
      ctrl.cancelAccountDeletion({
        id: req.params.id,
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
      }),
  );
};

export default adminComplianceRoutes;
