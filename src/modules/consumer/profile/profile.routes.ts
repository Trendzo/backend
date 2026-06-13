import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './profile.controller.js';
import { UpdateMeBody } from './profile.validators.js';

const consumerProfileRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('consumer'));

  app.get('/me', async (req) => ctrl.getMe({ auth: getAuth(req) }));

  app.patch(
    '/me',
    { schema: { body: UpdateMeBody } },
    async (req) => ctrl.updateMe({ auth: getAuth(req), body: req.body }),
  );
};

export default consumerProfileRoutes;
