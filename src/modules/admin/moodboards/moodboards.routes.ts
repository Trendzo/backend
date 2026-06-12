import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './moodboards.controller.js';
import { IdParam, ListQuery, TakedownBody } from './moodboards.validators.js';

const adminMoodboardRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/',
    {
      preHandler: requirePermission('community.moderate'),
      schema: { querystring: ListQuery },
    },
    async (req) => ctrl.listBoards({ query: req.query }),
  );

  app.post(
    '/:id/takedown',
    {
      preHandler: requirePermission('community.moderate'),
      schema: { params: IdParam, body: TakedownBody },
    },
    async (req) =>
      ctrl.takedown({ id: req.params.id, adminId: getAuth(req).sub, body: req.body }),
  );

  app.post(
    '/:id/restore',
    {
      preHandler: requirePermission('community.moderate'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.restore({ id: req.params.id }),
  );
};

export default adminMoodboardRoutes;
