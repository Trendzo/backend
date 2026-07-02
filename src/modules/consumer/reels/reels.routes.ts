import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './reels.controller.js';
import {
  CommentIdParam,
  CommentsQuery,
  CreateCommentBody,
  CreateReelBody,
  FeedQuery,
  IdParam,
} from './reels.validators.js';

const consumerReelsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('consumer'));

  // Step 1: upload the video (multipart) → returns URLs + metadata for the create call.
  app.post('/media', async (req) => ctrl.uploadReelMedia(req));

  // Step 2: create the reel from the uploaded media.
  app.post(
    '/',
    { schema: { body: CreateReelBody } },
    async (req) => ctrl.createReel({ auth: getAuth(req), body: req.body }),
  );

  app.get('/', { schema: { querystring: FeedQuery } }, async (req) =>
    ctrl.getFeed({ auth: getAuth(req), query: req.query }),
  );

  app.get('/mine', { schema: { querystring: FeedQuery } }, async (req) =>
    ctrl.listMine({ auth: getAuth(req), query: req.query }),
  );

  app.get('/saved', { schema: { querystring: FeedQuery } }, async (req) =>
    ctrl.listSaved({ auth: getAuth(req), query: req.query }),
  );

  app.get('/:id', { schema: { params: IdParam } }, async (req) =>
    ctrl.getReel({ auth: getAuth(req), id: req.params.id }),
  );

  app.delete('/:id', { schema: { params: IdParam } }, async (req) =>
    ctrl.deleteReel({ auth: getAuth(req), id: req.params.id }),
  );

  app.post('/:id/like', { schema: { params: IdParam } }, async (req) =>
    ctrl.likeReel({ auth: getAuth(req), id: req.params.id }),
  );
  app.delete('/:id/like', { schema: { params: IdParam } }, async (req) =>
    ctrl.unlikeReel({ auth: getAuth(req), id: req.params.id }),
  );

  app.post('/:id/save', { schema: { params: IdParam } }, async (req) =>
    ctrl.saveReel({ auth: getAuth(req), id: req.params.id }),
  );
  app.delete('/:id/save', { schema: { params: IdParam } }, async (req) =>
    ctrl.unsaveReel({ auth: getAuth(req), id: req.params.id }),
  );

  app.post('/:id/view', { schema: { params: IdParam } }, async (req) =>
    ctrl.recordView({ id: req.params.id }),
  );

  app.get(
    '/:id/comments',
    { schema: { params: IdParam, querystring: CommentsQuery } },
    async (req) => ctrl.listComments({ id: req.params.id, query: req.query }),
  );
  app.post(
    '/:id/comments',
    { schema: { params: IdParam, body: CreateCommentBody } },
    async (req) => ctrl.addComment({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );
  app.delete(
    '/:id/comments/:commentId',
    { schema: { params: CommentIdParam } },
    async (req) =>
      ctrl.deleteComment({ auth: getAuth(req), id: req.params.id, commentId: req.params.commentId }),
  );
};

export default consumerReelsRoutes;
