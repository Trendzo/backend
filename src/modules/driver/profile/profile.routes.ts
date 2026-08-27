/** Driver profile routes. Mounted at /driver/profile, gated by requireAuth('driver'). */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './profile.controller.js';
import { DeleteAccountRequestBody, UpdateProfileBody } from './profile.validators.js';

const driverProfileRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('driver'));

  app.get('/', async (req) => ctrl.getProfile({ auth: getAuth(req) }));

  app.patch(
    '/',
    { schema: { body: UpdateProfileBody } },
    async (req) => ctrl.updateProfile({ auth: getAuth(req), body: req.body }),
  );

  app.post(
    '/delete-request',
    { schema: { body: DeleteAccountRequestBody } },
    async (req) => ctrl.requestAccountDeletion({ auth: getAuth(req), body: req.body, requestId: req.id }),
  );
};

export default driverProfileRoutes;
