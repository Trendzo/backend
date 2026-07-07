/** Driver earnings routes. Mounted at /driver/earnings, gated by requireAuth('driver'). */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './earnings.controller.js';

const driverEarningsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('driver'));

  app.get('/summary', async (req) => ctrl.earningsSummary({ auth: getAuth(req) }));
};

export default driverEarningsRoutes;
