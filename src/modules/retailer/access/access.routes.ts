import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './access.controller.js';
import {
  CreateStaffBody,
  IdParam,
  InviteStaffBody,
  PatchStaffBody,
} from './access.validators.js';

const retailerAccessRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  app.get('/me/permissions', async (req) =>
    ctrl.getMyPermissions({ auth: getAuth(req) }),
  );

  app.get(
    '/staff',
    { preHandler: requirePermission('staff.list') },
    async (req) => ctrl.listStaff({ auth: getAuth(req) }),
  );

  app.get(
    '/staff/:id',
    { preHandler: requirePermission('staff.list'), schema: { params: IdParam } },
    async (req) => ctrl.getStaff({ auth: getAuth(req), id: req.params.id }),
  );

  app.patch(
    '/staff/:id',
    {
      preHandler: requirePermission('staff.change_role'),
      schema: { params: IdParam, body: PatchStaffBody },
    },
    async (req) =>
      ctrl.patchStaff({
        auth: getAuth(req),
        id: req.params.id,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/staff/deactivate/:id',
    {
      preHandler: requirePermission('staff.deactivate'),
      schema: { params: IdParam },
    },
    async (req) =>
      ctrl.deactivateStaff({
        auth: getAuth(req),
        id: req.params.id,
        requestId: req.id,
      }),
  );

  app.post(
    '/staff/reactivate/:id',
    {
      preHandler: requirePermission('staff.reactivate'),
      schema: { params: IdParam },
    },
    async (req) =>
      ctrl.reactivateStaff({
        auth: getAuth(req),
        id: req.params.id,
        requestId: req.id,
      }),
  );

  app.post(
    '/staff/:id/reset-password',
    {
      preHandler: requirePermission('staff.reset_password'),
      schema: { params: IdParam },
    },
    async (req) =>
      ctrl.resetStaffPassword({
        auth: getAuth(req),
        id: req.params.id,
        requestId: req.id,
      }),
  );

  app.get(
    '/staff/invites',
    { preHandler: requirePermission('staff.list') },
    async (req) => ctrl.listInvites({ auth: getAuth(req) }),
  );

  app.post(
    '/staff/create',
    {
      preHandler: requirePermission('staff.create'),
      schema: { body: CreateStaffBody },
    },
    async (req) =>
      ctrl.createStaff({
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/staff/invite',
    {
      preHandler: requirePermission('staff.invite'),
      schema: { body: InviteStaffBody },
    },
    async (req) =>
      ctrl.inviteStaff({
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
        log: req.log,
      }),
  );

  app.post(
    '/staff/invites/:id/resend',
    {
      preHandler: requirePermission('staff.invite'),
      schema: { params: IdParam },
    },
    async (req) =>
      ctrl.resendInvite({
        auth: getAuth(req),
        id: req.params.id,
        log: req.log,
      }),
  );

  app.post(
    '/staff/invites/:id/revoke',
    {
      preHandler: requirePermission('staff.invite'),
      schema: { params: IdParam },
    },
    async (req) =>
      ctrl.revokeInvite({
        auth: getAuth(req),
        id: req.params.id,
        requestId: req.id,
      }),
  );
};

export default retailerAccessRoutes;
