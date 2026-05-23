/**
 * Shared push-subscription route factory. Each actor kind mounts its own copy.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { ok } from '@/shared/http/envelope.js';
import {
  listPushSubscriptions,
  registerPushSubscription,
  revokePushSubscription,
  type RecipientKind,
} from '@/shared/notifications/push-subscriptions.js';

const RegisterBody = z.object({
  platform: z.enum(['web', 'ios', 'android']).default('web'),
  endpoint: z.string().url().min(1).max(2000),
  p256dh: z.string().max(256).optional(),
  auth: z.string().max(256).optional(),
  userAgent: z.string().max(512).optional(),
});

const IdParam = z.object({ id: z.string() });

export function pushRoutes(recipientKind: RecipientKind): FastifyPluginAsyncZod {
  return async (app) => {
    app.addHook('preHandler', requireAuth(recipientKind));

    app.get('/', async (req) => {
      const auth = getAuth(req);
      const rows = await listPushSubscriptions({ recipientKind, recipientId: auth.sub });
      return ok(rows);
    });

    app.post(
      '/',
      { schema: { body: RegisterBody } },
      async (req) => {
        const auth = getAuth(req);
        const id = await registerPushSubscription({
          recipientKind,
          recipientId: auth.sub,
          platform: req.body.platform,
          endpoint: req.body.endpoint,
          p256dh: req.body.p256dh,
          auth: req.body.auth,
          userAgent: req.body.userAgent,
        });
        return ok({ id });
      },
    );

    app.delete(
      '/:id',
      { schema: { params: IdParam } },
      async (req) => {
        const auth = getAuth(req);
        const revoked = await revokePushSubscription({
          id: req.params.id,
          recipientKind,
          recipientId: auth.sub,
        });
        return ok({ revoked });
      },
    );
  };
}
