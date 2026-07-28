import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './notifications.controller.js';
import { IdParam, ListNotificationsQuery } from './notifications.validators.js';

const consumerNotificationRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('consumer'));

  app.get(
    '/',
    { schema: { querystring: ListNotificationsQuery } },
    async (req) => ctrl.listNotifications({ auth: getAuth(req), query: req.query }),
  );

  app.post('/read-all', async (req) => ctrl.markAllRead({ auth: getAuth(req) }));

  app.post(
    '/:id/read',
    { schema: { params: IdParam } },
    async (req) => ctrl.markRead({ auth: getAuth(req), id: req.params.id }),
  );

  app.delete(
    '/:id',
    { schema: { params: IdParam } },
    async (req) => ctrl.deleteNotification({ auth: getAuth(req), id: req.params.id }),
  );
};

export default consumerNotificationRoutes;
