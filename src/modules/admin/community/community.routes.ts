import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './community.controller.js';
import { CommentParam, IdParam, ListQuery, TakedownBody } from './community.validators.js';

const adminCommunityRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // ── posts ──
  app.get(
    '/community-moderation',
    { preHandler: requirePermission('community.moderate'), schema: { querystring: ListQuery } },
    async (req) => ctrl.listCommunityModeration({ query: req.query }),
  );

  app.post(
    '/community-moderation/:id/takedown',
    {
      preHandler: requirePermission('community.moderate'),
      schema: { params: IdParam, body: TakedownBody },
    },
    async (req) => ctrl.takedownPost({ id: req.params.id, adminId: getAuth(req).sub, body: req.body }),
  );

  app.post(
    '/community-moderation/:id/restore',
    { preHandler: requirePermission('community.moderate'), schema: { params: IdParam } },
    async (req) => ctrl.restorePost({ id: req.params.id, adminId: getAuth(req).sub }),
  );

  app.post(
    '/community-moderation/:id/comments/:commentId/takedown',
    {
      preHandler: requirePermission('community.moderate'),
      schema: { params: CommentParam, body: TakedownBody },
    },
    async (req) =>
      ctrl.takedownPostComment({
        commentId: req.params.commentId,
        adminId: getAuth(req).sub,
        body: req.body,
      }),
  );

  app.post(
    '/community-moderation/:id/comments/:commentId/restore',
    { preHandler: requirePermission('community.moderate'), schema: { params: CommentParam } },
    async (req) =>
      ctrl.restorePostComment({ commentId: req.params.commentId, adminId: getAuth(req).sub }),
  );

  // ── product reviews ──
  app.get(
    '/reviews-moderation',
    { preHandler: requirePermission('community.moderate'), schema: { querystring: ListQuery } },
    async (req) => ctrl.listReviewsModeration({ query: req.query }),
  );

  app.post(
    '/reviews-moderation/:id/takedown',
    {
      preHandler: requirePermission('community.moderate'),
      schema: { params: IdParam, body: TakedownBody },
    },
    async (req) =>
      ctrl.takedownReview({ id: req.params.id, adminId: getAuth(req).sub, body: req.body }),
  );

  app.post(
    '/reviews-moderation/:id/restore',
    { preHandler: requirePermission('community.moderate'), schema: { params: IdParam } },
    async (req) => ctrl.restoreReview({ id: req.params.id, adminId: getAuth(req).sub }),
  );
};

export default adminCommunityRoutes;
