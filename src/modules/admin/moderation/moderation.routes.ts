import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './moderation.controller.js';
import {
  ActionsListQuery,
  AssignFlagBody,
  CreateFlagBody,
  DecideAppealBody,
  DecideReportBody,
  FlagIdParam,
  IdParam,
  ListFlagsQuery,
  PostIdParam,
  QueueQuery,
  RecordAuditBody,
  ResolveFlagBody,
  RetireListingBody,
  ReviewIdParam,
  TakedownBody,
} from './moderation.validators.js';

const adminModerationRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/catalog/moderation',
    {
      preHandler: requirePermission('moderation.view'),
      schema: { querystring: ListFlagsQuery },
    },
    async (req) => ctrl.listFlags({ query: req.query }),
  );

  app.post(
    '/catalog/moderation',
    {
      preHandler: requirePermission('moderation.decide'),
      schema: { body: CreateFlagBody },
    },
    async (req) => ctrl.createFlag({ body: req.body }),
  );

  app.post(
    '/catalog/moderation/:id/resolve',
    {
      preHandler: requirePermission('moderation.decide'),
      schema: { params: IdParam, body: ResolveFlagBody },
    },
    async (req) =>
      ctrl.resolveFlag({
        id: req.params.id,
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
      }),
  );

  app.get(
    '/catalog/moderation/:id/appeals',
    {
      preHandler: requirePermission('moderation.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.listAppeals(req.params.id),
  );

  app.post(
    '/catalog/moderation/:flagId/appeals/:id/decide',
    {
      preHandler: requirePermission('moderation.appeal_resolve'),
      schema: { params: FlagIdParam, body: DecideAppealBody },
    },
    async (req) =>
      ctrl.decideAppeal({
        flagId: req.params.flagId,
        appealId: req.params.id,
        auth: getAuth(req),
        body: req.body,
      }),
  );

  app.get(
    '/catalog/listings/:id/audit',
    {
      preHandler: requirePermission('moderation.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getListingAudit(req.params.id),
  );

  app.post(
    '/catalog/listings/:id/retire',
    {
      preHandler: requirePermission('moderation.decide'),
      schema: { params: IdParam, body: RetireListingBody },
    },
    async (req) =>
      ctrl.retireListing({
        id: req.params.id,
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
      }),
  );

  app.get(
    '/catalog/listings/:id/reports',
    {
      preHandler: requirePermission('moderation.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getListingReports(req.params.id),
  );

  app.post(
    '/catalog/listings/:id/audit',
    {
      preHandler: requirePermission('moderation.decide'),
      schema: { params: IdParam, body: RecordAuditBody },
    },
    async (req) =>
      ctrl.recordListingAudit({
        id: req.params.id,
        auth: getAuth(req),
        body: req.body,
      }),
  );

  app.patch(
    '/catalog/moderation/:id/assign',
    {
      preHandler: requirePermission('moderation.decide'),
      schema: { params: IdParam, body: AssignFlagBody },
    },
    async (req) => ctrl.assignFlag({ id: req.params.id, body: req.body }),
  );

  // ===== §20 Community + Review moderation queue =====
  app.get(
    '/moderation/queue',
    {
      preHandler: requirePermission('moderation.view'),
      schema: { querystring: QueueQuery },
    },
    async (req) => ctrl.listQueue({ query: req.query }),
  );

  app.get(
    '/moderation/reports/:id',
    {
      preHandler: requirePermission('moderation.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getReport({ id: req.params.id }),
  );

  app.post(
    '/moderation/reports/:id/decide',
    {
      preHandler: requirePermission('moderation.decide'),
      schema: { params: IdParam, body: DecideReportBody },
    },
    async (req) =>
      ctrl.decideReport({ id: req.params.id, body: req.body, auth: getAuth(req) }),
  );

  app.post(
    '/moderation/posts/:postId/takedown',
    {
      preHandler: requirePermission('moderation.decide'),
      schema: { params: PostIdParam, body: TakedownBody },
    },
    async (req) =>
      ctrl.takedownPost({ postId: req.params.postId, body: req.body, auth: getAuth(req) }),
  );

  app.post(
    '/moderation/reviews/:reviewId/takedown',
    {
      preHandler: requirePermission('moderation.decide'),
      schema: { params: ReviewIdParam, body: TakedownBody },
    },
    async (req) =>
      ctrl.takedownReview({ reviewId: req.params.reviewId, body: req.body, auth: getAuth(req) }),
  );

  app.get(
    '/moderation/actions',
    {
      preHandler: requirePermission('moderation.view'),
      schema: { querystring: ActionsListQuery },
    },
    async (req) => ctrl.listActions({ query: req.query }),
  );
};

export default adminModerationRoutes;
