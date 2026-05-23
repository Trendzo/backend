import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './staff-mgmt.controller.js';
import {
  ChangeRoleBody,
  CreateStaffBody,
  OptionalReasonBody,
  ResetPasswordBody,
  RetailerIdParam,
  StaffParam,
} from './staff-mgmt.validators.js';

const adminStaffMgmtRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/:id/staff',
    {
      preHandler: requirePermission('store_management.view'),
      schema: { params: RetailerIdParam },
    },
    async (req) => ctrl.listStaff({ id: req.params.id }),
  );

  app.post(
    '/:id/staff',
    {
      preHandler: requirePermission('store_management.edit'),
      schema: { params: RetailerIdParam, body: CreateStaffBody },
    },
    async (req) =>
      ctrl.createStaff({
        auth: getAuth(req),
        id: req.params.id,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.patch(
    '/:retailerId/staff/:accountId',
    {
      preHandler: requirePermission('store_management.edit'),
      schema: { params: StaffParam, body: ChangeRoleBody },
    },
    async (req) =>
      ctrl.changeRole({
        auth: getAuth(req),
        retailerId: req.params.retailerId,
        accountId: req.params.accountId,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/:retailerId/staff/:accountId/deactivate',
    {
      preHandler: requirePermission('store_management.edit'),
      schema: { params: StaffParam, body: OptionalReasonBody },
    },
    async (req) =>
      ctrl.deactivateStaff({
        auth: getAuth(req),
        retailerId: req.params.retailerId,
        accountId: req.params.accountId,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/:retailerId/staff/:accountId/reactivate',
    {
      preHandler: requirePermission('store_management.edit'),
      schema: { params: StaffParam, body: OptionalReasonBody },
    },
    async (req) =>
      ctrl.reactivateStaff({
        auth: getAuth(req),
        retailerId: req.params.retailerId,
        accountId: req.params.accountId,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/:retailerId/staff/:accountId/reset-password',
    {
      preHandler: requirePermission('store_management.edit'),
      schema: { params: StaffParam, body: ResetPasswordBody },
    },
    async (req) =>
      ctrl.resetPassword({
        auth: getAuth(req),
        retailerId: req.params.retailerId,
        accountId: req.params.accountId,
        body: req.body,
        requestId: req.id,
      }),
  );
};

export default adminStaffMgmtRoutes;
