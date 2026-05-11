import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import {
  notificationPreferences,
  notifications,
} from '@/db/schema/index.js';
import { ok } from '@/shared/http/envelope.js';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';

const adminStoreOpsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // ===== GET /admin/inbox =====
  app.get(
    '/inbox',
    {
      schema: {
        querystring: z.object({
          unreadOnly: z.coerce.boolean().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const { unreadOnly, limit } = req.query;
      const conditions = [
        eq(notifications.recipientKind, 'admin'),
        eq(notifications.recipientId, auth.sub),
        isNull(notifications.deletedAt),
      ];
      if (unreadOnly) conditions.push(isNull(notifications.readAt));
      const rows = await db.query.notifications.findMany({
        where: and(...conditions),
        orderBy: desc(notifications.createdAt),
        limit,
      });
      return ok(rows);
    },
  );

  // ===== POST /admin/inbox/:id/read =====
  app.post(
    '/inbox/:id/read',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const auth = getAuth(req);
      await db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(and(eq(notifications.id, req.params.id), eq(notifications.recipientId, auth.sub)));
      return ok({ id: req.params.id, readAt: new Date() });
    },
  );

  // ===== POST /admin/inbox/read-all =====
  app.post('/inbox/read-all', async (req) => {
    const auth = getAuth(req);
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.recipientKind, 'admin'),
          eq(notifications.recipientId, auth.sub),
          isNull(notifications.readAt),
          isNull(notifications.deletedAt),
        ),
      );
    return ok({ marked: true });
  });

  // ===== GET /admin/notification-prefs =====
  app.get('/notification-prefs', async (req) => {
    const auth = getAuth(req);
    const prefs = await db.query.notificationPreferences.findFirst({
      where: and(
        eq(notificationPreferences.accountKind, 'admin'),
        eq(notificationPreferences.accountId, auth.sub),
      ),
    });
    return ok(
      prefs ?? {
        accountKind: 'admin',
        accountId: auth.sub,
        pushEnabled: true,
        emailEnabled: true,
        dailyDigestEnabled: false,
        smsEnabled: false,
        language: 'en-IN',
        dashboardTiles: null,
      },
    );
  });
};

export default adminStoreOpsRoutes;
