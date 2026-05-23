import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './community.controller.js';
import {
  CreatePostBody,
  CreateReportBody,
  CreateReviewBody,
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
};

export default consumerCommunityRoutes;
