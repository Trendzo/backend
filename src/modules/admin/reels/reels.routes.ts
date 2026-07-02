import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './reels.controller.js';
import { CommentParam, IdParam, ListQuery, TakedownBody } from './reels.validators.js';

const adminReelsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/',
    { preHandler: requirePermission('community.moderate'), schema: { querystring: ListQuery } },
    async (req) => ctrl.listReels({ query: req.query }),
  );

  app.post(
    '/:id/takedown',
    {
      preHandler: requirePermission('community.moderate'),
      schema: { params: IdParam, body: TakedownBody },
    },
    async (req) => ctrl.takedownReel({ id: req.params.id, adminId: getAuth(req).sub, body: req.body }),
  );

  app.post(
    '/:id/restore',
    { preHandler: requirePermission('community.moderate'), schema: { params: IdParam } },
    async (req) => ctrl.restoreReel({ id: req.params.id, adminId: getAuth(req).sub }),
  );

  app.post(
    '/:id/comments/:commentId/takedown',
    {
      preHandler: requirePermission('community.moderate'),
      schema: { params: CommentParam, body: TakedownBody },
    },
    async (req) =>
      ctrl.takedownComment({
        commentId: req.params.commentId,
        adminId: getAuth(req).sub,
        body: req.body,
      }),
  );

  app.post(
    '/:id/comments/:commentId/restore',
    { preHandler: requirePermission('community.moderate'), schema: { params: CommentParam } },
    async (req) =>
      ctrl.restoreComment({ commentId: req.params.commentId, adminId: getAuth(req).sub }),
  );
};

export default adminReelsRoutes;
