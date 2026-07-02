import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './community.controller.js';
import {
  CommentIdParam,
  CommentsQuery,
  CreateCommentBody,
  CreatePostBody,
  CreateReportBody,
  CreateReviewBody,
  FeedQuery,
  IdParam,
  ListMineQuery,
} from './community.validators.js';

const consumerCommunityRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('consumer'));

  app.post(
    '/posts',
    { schema: { body: CreatePostBody } },
    async (req) => ctrl.createPost({ auth: getAuth(req), body: req.body }),
  );

  app.post(
    '/reviews',
    { schema: { body: CreateReviewBody } },
    async (req) => ctrl.createReview({ auth: getAuth(req), body: req.body }),
  );

  app.post(
    '/reports',
    { schema: { body: CreateReportBody } },
    async (req) => ctrl.createReport({ auth: getAuth(req), body: req.body }),
  );

  app.get(
    '/posts/mine',
    { schema: { querystring: ListMineQuery } },
    async (req) => ctrl.listMyPosts({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/reviews/mine',
    { schema: { querystring: ListMineQuery } },
    async (req) => ctrl.listMyReviews({ auth: getAuth(req), query: req.query }),
  );

  // ── public posts feed + interactions ──

  app.get('/posts', { schema: { querystring: FeedQuery } }, async (req) =>
    ctrl.getPostsFeed({ auth: getAuth(req), query: req.query }),
  );

  app.get('/posts/:id', { schema: { params: IdParam } }, async (req) =>
    ctrl.getPost({ auth: getAuth(req), id: req.params.id }),
  );

  app.delete('/posts/:id', { schema: { params: IdParam } }, async (req) =>
    ctrl.deletePost({ auth: getAuth(req), id: req.params.id }),
  );

  app.post('/posts/:id/like', { schema: { params: IdParam } }, async (req) =>
    ctrl.likePost({ auth: getAuth(req), id: req.params.id }),
  );
  app.delete('/posts/:id/like', { schema: { params: IdParam } }, async (req) =>
    ctrl.unlikePost({ auth: getAuth(req), id: req.params.id }),
  );

  app.post('/posts/:id/save', { schema: { params: IdParam } }, async (req) =>
    ctrl.savePost({ auth: getAuth(req), id: req.params.id }),
  );
  app.delete('/posts/:id/save', { schema: { params: IdParam } }, async (req) =>
    ctrl.unsavePost({ auth: getAuth(req), id: req.params.id }),
  );

  app.get(
    '/posts/:id/comments',
    { schema: { params: IdParam, querystring: CommentsQuery } },
    async (req) => ctrl.listPostComments({ id: req.params.id, query: req.query }),
  );
  app.post(
    '/posts/:id/comments',
    { schema: { params: IdParam, body: CreateCommentBody } },
    async (req) => ctrl.addPostComment({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );
  app.delete(
    '/posts/:id/comments/:commentId',
    { schema: { params: CommentIdParam } },
    async (req) =>
      ctrl.deletePostComment({
        auth: getAuth(req),
        id: req.params.id,
        commentId: req.params.commentId,
      }),
  );
};

export default consumerCommunityRoutes;
