/** Driver location ping. Mounted at /driver/location, gated by requireAuth('driver'). */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './location.controller.js';
import { LocationPingBody } from './location.validators.js';

const driverLocationRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('driver'));

  app.post(
    '/',
    { schema: { body: LocationPingBody } },
    async (req) => ctrl.pingLocation({ auth: getAuth(req), body: req.body }),
  );
};

export default driverLocationRoutes;
