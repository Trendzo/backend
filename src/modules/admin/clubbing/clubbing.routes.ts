import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './clubbing.controller.js';
import { UpsertBody } from './clubbing.validators.js';

const adminClubbingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/',
    { preHandler: requirePermission('clubbing.view') },
    async () => ctrl.listMatrix(),
  );

  app.put(
    '/',
    {
      preHandler: requirePermission('clubbing.edit'),
      schema: { body: UpsertBody },
    },
    async (req) => ctrl.upsertMatrix({ body: req.body }),
  );
};

export default adminClubbingRoutes;
