import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, getAuthOptional, optionalAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './reels.controller.js';
import {
  CommentIdParam,
  CommentsQuery,
  CreateCommentBody,
  CreateReelBody,
  FeedQuery,
  IdParam,
} from './reels.validators.js';

/**
 * Consumer reels.
 *
 * AUTH IS PER-ROUTE, deliberately. This module used to carry a single
 * `app.addHook('preHandler', requireAuth('consumer'))`, which meant the FEED, a
 * single reel, the comment list and even the view counter all 401'd for a signed
 * out visitor — so the app fell back to bundled demo videos and a guest never saw
 * a real reel at all.
 *
 * The split now matches the product rule:
 *   • read (feed, one reel, its comments, counting a view) — open to everyone
 *   • write (post, like, save, comment, delete) — signed-in consumer
 *   • the shopper's own shelves (mine, saved) — signed-in, they are personal
 *   • sharing is not a route: it happens entirely on the device, so it is free
 *     for guests by construction.
 */
const consumerReelsRoutes: FastifyPluginAsyncZod = async (app) => {
  // ── Public reads. `optionalAuth` never rejects; it only enriches the response
  //    with this viewer's liked/saved flags when a valid token happens to be present.
  app.get(
    '/',
    { preHandler: optionalAuth('consumer'), schema: { querystring: FeedQuery } },
    async (req) => ctrl.getFeed({ auth: getAuthOptional(req), query: req.query }),
  );

  app.get(
    '/:id',
    { preHandler: optionalAuth('consumer'), schema: { params: IdParam } },
    async (req) => ctrl.getReel({ auth: getAuthOptional(req), id: req.params.id }),
  );

  app.get(
    '/:id/comments',
    { preHandler: optionalAuth('consumer'), schema: { params: IdParam, querystring: CommentsQuery } },
    async (req) => ctrl.listComments({ id: req.params.id, query: req.query }),
  );

  // A view is a view whoever watched it — gating this undercounted every guest.
  app.post(
    '/:id/view',
    { preHandler: optionalAuth('consumer'), schema: { params: IdParam } },
    async (req) => ctrl.recordView({ id: req.params.id }),
  );

  // ── Creating: upload the video first, then create the reel from the returned URLs.
  app.post('/media', { preHandler: requireAuth('consumer') }, async (req) =>
    ctrl.uploadReelMedia(req),
  );

  app.post(
    '/',
    { preHandler: requireAuth('consumer'), schema: { body: CreateReelBody } },
    async (req) => ctrl.createReel({ auth: getAuth(req), body: req.body }),
  );

  app.delete(
    '/:id',
    { preHandler: requireAuth('consumer'), schema: { params: IdParam } },
    async (req) => ctrl.deleteReel({ auth: getAuth(req), id: req.params.id }),
  );

  // ── Personal shelves.
  app.get(
    '/mine',
    { preHandler: requireAuth('consumer'), schema: { querystring: FeedQuery } },
    async (req) => ctrl.listMine({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/saved',
    { preHandler: requireAuth('consumer'), schema: { querystring: FeedQuery } },
    async (req) => ctrl.listSaved({ auth: getAuth(req), query: req.query }),
  );

  // ── Interactions — every one of these attributes an action to a person.
  app.post(
    '/:id/like',
    { preHandler: requireAuth('consumer'), schema: { params: IdParam } },
    async (req) => ctrl.likeReel({ auth: getAuth(req), id: req.params.id }),
  );
  app.delete(
    '/:id/like',
    { preHandler: requireAuth('consumer'), schema: { params: IdParam } },
    async (req) => ctrl.unlikeReel({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/:id/save',
    { preHandler: requireAuth('consumer'), schema: { params: IdParam } },
    async (req) => ctrl.saveReel({ auth: getAuth(req), id: req.params.id }),
  );
  app.delete(
    '/:id/save',
    { preHandler: requireAuth('consumer'), schema: { params: IdParam } },
    async (req) => ctrl.unsaveReel({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/:id/comments',
    { preHandler: requireAuth('consumer'), schema: { params: IdParam, body: CreateCommentBody } },
    async (req) => ctrl.addComment({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );
  app.delete(
    '/:id/comments/:commentId',
    { preHandler: requireAuth('consumer'), schema: { params: CommentIdParam } },
    async (req) =>
      ctrl.deleteComment({ auth: getAuth(req), id: req.params.id, commentId: req.params.commentId }),
  );
};

export default consumerReelsRoutes;
