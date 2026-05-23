import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import { ok } from '@/shared/http/envelope.js';
import {
  buildAdminDigest,
  buildRetailerDigest,
  queueAdminDigest,
  queueAllDigests,
  queueRetailerDigest,
} from '@/shared/digest/daily-digest.js';

const TargetBody = z.object({
  recipientKind: z.enum(['retailer', 'admin']),
  recipientId: z.string().min(1),
});

const adminDigestRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/preview/me',
    { preHandler: requirePermission('platform_config.view') },
    async (req) => {
      const auth = getAuth(req);
      return ok(await buildAdminDigest(auth.sub));
    },
  );

  app.post(
    '/preview',
    {
      preHandler: requirePermission('platform_config.view'),
      schema: { body: TargetBody },
    },
    async (req) => {
      const d =
        req.body.recipientKind === 'admin'
          ? await buildAdminDigest(req.body.recipientId)
          : await buildRetailerDigest(req.body.recipientId);
      return ok(d);
    },
  );

  app.post(
    '/queue',
    {
      preHandler: requirePermission('platform_config.edit'),
      schema: { body: TargetBody },
    },
    async (req) => {
      const id =
        req.body.recipientKind === 'admin'
          ? await queueAdminDigest(req.body.recipientId)
          : await queueRetailerDigest(req.body.recipientId);
      return ok({ emailOutboxId: id });
    },
  );

  app.post(
    '/queue-all',
    { preHandler: requirePermission('platform_config.edit') },
    async () => ok(await queueAllDigests()),
  );
};

export default adminDigestRoutes;
