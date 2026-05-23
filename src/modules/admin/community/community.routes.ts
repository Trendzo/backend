import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './community.controller.js';

const adminCommunityRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/community-moderation',
    { preHandler: requirePermission('community.moderate') },
    async () => ctrl.listCommunityModeration(),
  );

  app.get(
    '/reviews-moderation',
    { preHandler: requirePermission('community.moderate') },
    async () => ctrl.listReviewsModeration(),
  );
};

export default adminCommunityRoutes;
