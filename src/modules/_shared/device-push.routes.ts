/**
 * Shared native-push device-token route factory. Each app kind mounts its own copy to
 * register/revoke its FCM (or APNs) device token for TARGETED push. The auth token kind
 * ('driver' | 'consumer') maps to the stored recipient kind ('delivery_agent' | 'consumer').
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { ok } from '@/shared/http/envelope.js';
import {
  registerDeviceToken,
  revokeDeviceToken,
} from '@/shared/notifications/device-tokens.js';

const RegisterBody = z.object({
  token: z.string().min(1).max(4096),
  platform: z.enum(['ios', 'android']),
  appVersion: z.string().max(64).optional(),
});

const RevokeBody = z.object({ token: z.string().min(1).max(4096) });

export function deviceTokenRoutes(
  tokenKind: 'driver' | 'consumer',
  recipientKind: 'delivery_agent' | 'consumer',
): FastifyPluginAsyncZod {
  return async (app) => {
    app.addHook('preHandler', requireAuth(tokenKind));

    app.post('/', { schema: { body: RegisterBody } }, async (req) => {
      const auth = getAuth(req);
      const { id } = await registerDeviceToken({
        recipientKind,
        recipientId: auth.sub,
        token: req.body.token,
        platform: req.body.platform,
        ...(req.body.appVersion !== undefined && { appVersion: req.body.appVersion }),
      });
      return ok({ id });
    });

    app.post('/revoke', { schema: { body: RevokeBody } }, async (req) => {
      const auth = getAuth(req);
      await revokeDeviceToken({ recipientKind, recipientId: auth.sub, token: req.body.token });
      return ok({ revoked: true });
    });
  };
}
