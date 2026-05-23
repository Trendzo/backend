import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './store-ops.controller.js';
import { IdParam, InboxQuery } from './store-ops.validators.js';

const adminStoreOpsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/inbox',
    { schema: { querystring: InboxQuery } },
    async (req) => ctrl.listInbox({ auth: getAuth(req), query: req.query }),
  );

  app.post(
    '/inbox/:id/read',
    { schema: { params: IdParam } },
    async (req) => ctrl.markInboxRead({ id: req.params.id, auth: getAuth(req) }),
  );

  app.post('/inbox/read-all', async (req) =>
    ctrl.markAllRead({ auth: getAuth(req) }),
  );

  app.get('/notification-prefs', async (req) =>
    ctrl.getNotificationPrefs({ auth: getAuth(req) }),
  );
};

export default adminStoreOpsRoutes;
