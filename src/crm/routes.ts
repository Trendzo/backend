import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAnyCrmAuth, requireCrmAdminAuth, resolveActor } from './auth.js';
import crmAuthRoutes from './modules/auth/auth.routes.js';
import * as retailersCtrl from './modules/retailers/retailers.controller.js';
import * as actionsCtrl from './modules/retailers/actions.controller.js';
import * as docsCtrl from './modules/retailers/documents.controller.js';
import * as workspaceCtrl from './modules/workspace/workspace.controller.js';
import * as execStatsCtrl from './modules/stats/exec-stats.controller.js';
import * as adminStatsCtrl from './modules/stats/admin-stats.controller.js';
import { AdminStatsQuery } from './modules/stats/admin-stats.controller.js';
import * as teamCtrl from './modules/team/team.controller.js';
import * as reportsCtrl from './modules/team/reports.controller.js';
import {
  ActionBody,
  CreateRetailerBody,
  DocumentIdParam,
  ListFollowupsQuery,
  ListRetailersQuery,
  ListVisitsQuery,
  RetailerIdParam,
  UpdateRetailerBody,
} from './modules/retailers/retailers.validators.js';
import {
  CreateCategoryBody,
  CreateTeamMemberBody,
  CreateTerritoryBody,
  IdQuery,
  ReportQuery,
  SetTargetsBody,
  TeamIdParam,
  UpdateTeamMemberBody,
} from './modules/team/team.validators.js';

/**
 * Field-sales CRM API, mounted at `/api/v1/crm`.
 *
 * Two principals reach these routes and the split is deliberate:
 *  - a salesperson (`kind: 'crm'`, phone-OTP, account in the CRM's own MongoDB)
 *  - a platform admin (`kind: 'admin'`, the EXISTING Postgres admin account)
 *
 * Admin identity is the single thing shared with the web portal. No CRM business data is
 * shared in either direction: a CRM "retailer" is a sales prospect, a platform retailer is
 * an onboarded merchant, and nothing joins them.
 *
 * Most routes accept either principal and rely on `visibleUserIds` for scoping — a rep sees
 * their own book, a manager their team's, an admin everything. Routes that are inherently
 * management (team, targets, reports) require the admin/manager path explicitly.
 */
const crmRoutes: FastifyPluginAsyncZod = async (app) => {
  await app.register(crmAuthRoutes, { prefix: '/auth' });

  // ── Leads ──────────────────────────────────────────────────────────────────
  app.get(
    '/retailers',
    { preHandler: requireAnyCrmAuth, schema: { querystring: ListRetailersQuery } },
    async (req) => retailersCtrl.listRetailers({ actor: await resolveActor(req), query: req.query }),
  );

  app.post(
    '/retailers',
    { preHandler: requireAnyCrmAuth, schema: { body: CreateRetailerBody } },
    async (req, reply) => {
      const result = await retailersCtrl.createRetailer({
        actor: await resolveActor(req),
        body: req.body,
      });
      void reply.status(201);
      return result;
    },
  );

  app.get(
    '/retailers/:id',
    { preHandler: requireAnyCrmAuth, schema: { params: RetailerIdParam } },
    async (req) =>
      retailersCtrl.getRetailerDetail({ actor: await resolveActor(req), id: req.params.id }),
  );

  app.patch(
    '/retailers/:id',
    { preHandler: requireAnyCrmAuth, schema: { params: RetailerIdParam, body: UpdateRetailerBody } },
    async (req) =>
      retailersCtrl.updateRetailer({
        actor: await resolveActor(req),
        id: req.params.id,
        body: req.body,
      }),
  );

  // Single mutation endpoint — see actions.controller for why everything funnels here.
  app.post(
    '/retailers/:id/actions',
    { preHandler: requireAnyCrmAuth, schema: { params: RetailerIdParam, body: ActionBody } },
    async (req) =>
      actionsCtrl.runAction({ actor: await resolveActor(req), id: req.params.id, body: req.body }),
  );

  // ── Documents ──────────────────────────────────────────────────────────────
  // No Zod body schema: this is multipart, parsed by @fastify/multipart inside the handler.
  app.post(
    '/retailers/:id/documents',
    { preHandler: requireAnyCrmAuth, schema: { params: RetailerIdParam } },
    async (req, reply) => {
      const result = await docsCtrl.uploadDocument({
        actor: await resolveActor(req),
        id: req.params.id,
        req,
      });
      void reply.status(201);
      return result;
    },
  );

  app.get(
    '/documents',
    {
      preHandler: requireAnyCrmAuth,
      schema: { querystring: z.object({ retailer: z.string().max(80).optional() }) },
    },
    async (req) =>
      docsCtrl.listDocuments({
        actor: await resolveActor(req),
        retailerId: req.query.retailer,
      }),
  );

  app.get(
    '/documents/:id',
    { preHandler: requireAnyCrmAuth, schema: { params: DocumentIdParam } },
    async (req, reply) => {
      const doc = await docsCtrl.getDocument({ actor: await resolveActor(req), id: req.params.id });
      return reply
        .header('Content-Type', doc.mime)
        .header('Content-Disposition', `inline; filename="${doc.filename}"`)
        // Field documents are personal data — never let a shared cache hold a copy.
        .header('Cache-Control', 'private, max-age=3600')
        .send(doc.buffer);
    },
  );

  // ── Queues ─────────────────────────────────────────────────────────────────
  app.get(
    '/followups',
    { preHandler: requireAnyCrmAuth, schema: { querystring: ListFollowupsQuery } },
    async (req) => workspaceCtrl.listFollowups({ actor: await resolveActor(req), query: req.query }),
  );

  app.get(
    '/visits',
    { preHandler: requireAnyCrmAuth, schema: { querystring: ListVisitsQuery } },
    async (req) => workspaceCtrl.listVisits({ actor: await resolveActor(req), query: req.query }),
  );

  // ── Reference data ─────────────────────────────────────────────────────────
  app.get('/categories', { preHandler: requireAnyCrmAuth }, async () =>
    workspaceCtrl.listCategories(),
  );

  app.post(
    '/categories',
    { preHandler: requireCrmAdminAuth, schema: { body: CreateCategoryBody } },
    async (req, reply) => {
      const result = await workspaceCtrl.createCategory({
        actor: await resolveActor(req),
        name: req.body.name,
      });
      void reply.status(201);
      return result;
    },
  );

  app.delete(
    '/categories',
    { preHandler: requireCrmAdminAuth, schema: { querystring: IdQuery } },
    async (req) =>
      workspaceCtrl.deleteCategory({ actor: await resolveActor(req), id: req.query.id }),
  );

  app.get('/territories', { preHandler: requireAnyCrmAuth }, async () =>
    workspaceCtrl.listTerritories(),
  );

  app.post(
    '/territories',
    { preHandler: requireCrmAdminAuth, schema: { body: CreateTerritoryBody } },
    async (req, reply) => {
      const result = await workspaceCtrl.createTerritory({
        actor: await resolveActor(req),
        city: req.body.city,
        name: req.body.name,
      });
      void reply.status(201);
      return result;
    },
  );

  app.delete(
    '/territories',
    { preHandler: requireCrmAdminAuth, schema: { querystring: IdQuery } },
    async (req) =>
      workspaceCtrl.deleteTerritory({ actor: await resolveActor(req), id: req.query.id }),
  );

  // ── Analytics ──────────────────────────────────────────────────────────────
  app.get('/stats/exec', { preHandler: requireAnyCrmAuth }, async (req) =>
    execStatsCtrl.execStats({ actor: await resolveActor(req) }),
  );

  app.get('/filters', { preHandler: requireAnyCrmAuth }, async (req) =>
    execStatsCtrl.filterOptions({ actor: await resolveActor(req) }),
  );

  app.get(
    '/stats/admin',
    { preHandler: requireAnyCrmAuth, schema: { querystring: AdminStatsQuery } },
    async (req) => adminStatsCtrl.adminStats({ actor: await resolveActor(req), query: req.query }),
  );

  // ── Team & targets ─────────────────────────────────────────────────────────
  // Managers legitimately administer their own reports, so these accept either principal
  // and enforce scope per-record rather than gating the whole surface on admin.
  app.get('/team', { preHandler: requireAnyCrmAuth }, async (req) =>
    teamCtrl.listTeam({ actor: await resolveActor(req) }),
  );

  app.post(
    '/team',
    { preHandler: requireAnyCrmAuth, schema: { body: CreateTeamMemberBody } },
    async (req, reply) => {
      const result = await teamCtrl.createTeamMember({
        actor: await resolveActor(req),
        body: req.body,
      });
      void reply.status(201);
      return result;
    },
  );

  app.patch(
    '/team/:id',
    { preHandler: requireAnyCrmAuth, schema: { params: TeamIdParam, body: UpdateTeamMemberBody } },
    async (req) =>
      teamCtrl.updateTeamMember({
        actor: await resolveActor(req),
        id: req.params.id,
        body: req.body,
      }),
  );

  app.get('/targets', { preHandler: requireAnyCrmAuth }, async (req) =>
    teamCtrl.getTargetsOverview({ actor: await resolveActor(req) }),
  );

  app.post(
    '/targets',
    { preHandler: requireAnyCrmAuth, schema: { body: SetTargetsBody } },
    async (req) => teamCtrl.setTargets({ actor: await resolveActor(req), body: req.body }),
  );

  // ── Reports ────────────────────────────────────────────────────────────────
  app.get(
    '/reports',
    { preHandler: requireAnyCrmAuth, schema: { querystring: ReportQuery } },
    async (req, reply) => {
      const actor = await resolveActor(req);
      if (req.query.format !== 'csv') {
        return reportsCtrl.reportJson({ actor, query: req.query });
      }
      const { rows, filename } = await reportsCtrl.buildReport({ actor, query: req.query });
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        // Excel needs a BOM to read UTF-8 CSVs without mangling non-ASCII store names.
        .send(`﻿${reportsCtrl.toCsv(rows)}`);
    },
  );
};

export default crmRoutes;
