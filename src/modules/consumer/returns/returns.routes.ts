import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './returns.controller.js';
import { CreateReturnBody } from './returns.validators.js';

const consumerReturnsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('consumer'));

  app.get('/', async (req) => ctrl.listReturns({ auth: getAuth(req) }));

  app.post(
    '/',
    { schema: { body: CreateReturnBody } },
    async (req) => ctrl.createReturn({ auth: getAuth(req), body: req.body }),
  );
};

export default consumerReturnsRoutes;
