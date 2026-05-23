import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './access.controller.js';
import {
  AuditLogQuery,
  CreateTeamBody,
  IdParam,
  ImpersonationStartBody,
  ImpersonationStopBody,
  RevokeBody,
  SubRoleOverrideBody,
  UpdateTeamBody,
} from './access.validators.js';

const adminAccessRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get('/me/permissions', async (req) =>
    ctrl.getMyPermissions({ auth: getAuth(req) }),
  );

  app.get(
    '/team',
    { preHandler: requirePermission('team.list') },
    async () => ctrl.listTeam(),
  );

  app.post(
    '/team',
    {
      preHandler: requirePermission('team.create'),
      schema: { body: CreateTeamBody },
    },
    async (req) =>
      ctrl.createTeamMember({ auth: getAuth(req), body: req.body, requestId: req.id }),
  );

  app.patch(
    '/team/:id',
    {
      preHandler: requirePermission('team.update'),
      schema: { params: IdParam, body: UpdateTeamBody },
    },
    async (req) =>
      ctrl.updateTeamMember({
        id: req.params.id,
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/team/:id/reset-password',
    {
      preHandler: requirePermission('team.reset_password'),
      schema: { params: IdParam },
    },
    async (req) =>
      ctrl.resetTeamPassword({
        id: req.params.id,
        auth: getAuth(req),
        requestId: req.id,
      }),
  );

  app.post(
    '/team/:id/revoke',
    {
      preHandler: requirePermission('team.revoke'),
      schema: { params: IdParam, body: RevokeBody },
    },
    async (req) =>
      ctrl.revokeTeamMember({
        id: req.params.id,
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/team/:id/reinstate',
    {
      preHandler: requirePermission('team.reinstate'),
      schema: { params: IdParam },
    },
    async (req) =>
      ctrl.reinstateTeamMember({
        id: req.params.id,
        auth: getAuth(req),
        requestId: req.id,
      }),
  );

  app.get(
    '/sub-roles',
    { preHandler: requirePermission('sub_roles.view') },
    async () => ctrl.listSubRoles(),
  );

  app.patch(
    '/sub-roles',
    {
      preHandler: requirePermission('sub_roles.edit'),
      schema: { body: SubRoleOverrideBody },
    },
    async (req) =>
      ctrl.upsertSubRoleOverride({
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/impersonation/start',
    {
      preHandler: requirePermission('impersonation.start'),
      schema: { body: ImpersonationStartBody },
    },
    async (req) =>
      ctrl.startImpersonation({
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/impersonation/stop',
    {
      preHandler: requirePermission('impersonation.end'),
      schema: { body: ImpersonationStopBody },
    },
    async (req) =>
      ctrl.stopImpersonation({
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
      }),
  );

  app.get(
    '/audit-log',
    {
      preHandler: requirePermission('audit_log.view'),
      schema: { querystring: AuditLogQuery },
    },
    async (req) => ctrl.listAuditLog({ query: req.query }),
  );
};

export default adminAccessRoutes;
