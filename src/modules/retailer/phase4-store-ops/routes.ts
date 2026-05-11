import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import {
  bankAccounts,
  kycReverifications,
  notificationPreferences,
  notifications,
  retailerAccounts,
  retailerStores,
  storeHolidayClosures,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { recordAudit } from '@/shared/audit.js';

async function loadStore(retailerId: string) {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
  });
  if (!retailer?.storeId) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, retailer.storeId),
  });
  if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  return store;
}

const retailerStoreOpsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  // ===== GET /retailer/store/hours =====
  app.get('/store/hours', async (req) => {
    const auth = getAuth(req);
    const store = await loadStore(auth.sub);
    const raw = store.openingHours ?? {};
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
    const result: Record<string, { from: string; to: string; closed: boolean }> = {};
    for (const day of days) {
      const slots = raw[day];
      if (slots && slots.length > 0) {
        const first = slots[0]!;
        result[day] = { from: first.open, to: first.close, closed: false };
      } else {
        result[day] = { from: '09:00', to: '18:00', closed: true };
      }
    }
    return ok(result);
  });

  // ===== GET /retailer/store/bank =====
  app.get('/store/bank', async (req) => {
    const auth = getAuth(req);
    const store = await loadStore(auth.sub);
    const bank = await db.query.bankAccounts.findFirst({
      where: and(eq(bankAccounts.storeId, store.id), eq(bankAccounts.isDefault, true)),
    });
    if (!bank) return ok(null);
    return ok({
      accountHolderName: bank.legalName,
      accountNumber: bank.accountNumber,
      ifsc: bank.ifsc,
      bankName: null as string | null,
      pennyDropStatus: bank.verifiedAt ? 'matched' : 'not_attempted',
      pennyDropAt: bank.verifiedAt ? bank.verifiedAt.toISOString() : null,
    });
  });

  // ===== GET /retailer/store/documents — KYC documents from latest reverification =====
  app.get('/store/documents', async (req) => {
    const auth = getAuth(req);
    const store = await loadStore(auth.sub);
    const rev = await db.query.kycReverifications.findFirst({
      where: eq(kycReverifications.storeId, store.id),
      orderBy: desc(kycReverifications.dueAt),
      with: { documents: true },
    });
    if (!rev) return ok([]);
    return ok(
      rev.documents.map((d) => ({
        id: d.id,
        kind: d.kind,
        label: d.kind.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
        status: d.status,
        uploadedAt: d.uploadedAt ? d.uploadedAt.toISOString() : null,
        fileUrl: d.url ?? null,
      })),
    );
  });

  // ===== GET /retailer/store/holiday-closures =====
  app.get('/store/holiday-closures', async (req) => {
    const auth = getAuth(req);
    const store = await loadStore(auth.sub);
    const rows = await db.query.storeHolidayClosures.findMany({
      where: eq(storeHolidayClosures.storeId, store.id),
      orderBy: (t, { asc }) => [asc(t.date)],
    });
    return ok(rows);
  });

  // ===== POST /retailer/store/holiday-closures =====
  app.post(
    '/store/holiday-closures',
    {
      schema: {
        body: z.object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
          reason: z.string().trim().max(200).optional(),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const store = await loadStore(auth.sub);
      await db
        .insert(storeHolidayClosures)
        .values({
          storeId: store.id,
          date: req.body.date,
          reason: req.body.reason ?? null,
          createdByAccountId: auth.sub,
        })
        .onConflictDoNothing();
      return ok({ storeId: store.id, date: req.body.date });
    },
  );

  // ===== DELETE /retailer/store/holiday-closures/:date =====
  app.delete(
    '/store/holiday-closures/:date',
    {
      schema: {
        params: z.object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const store = await loadStore(auth.sub);
      await db
        .delete(storeHolidayClosures)
        .where(
          and(
            eq(storeHolidayClosures.storeId, store.id),
            eq(storeHolidayClosures.date, req.params.date),
          ),
        );
      return ok({ deleted: true });
    },
  );

  // ===== POST /retailer/store/pause =====
  app.post(
    '/store/pause',
    {
      schema: {
        body: z.object({
          visibility: z.enum(['visible', 'hidden']),
          reason: z.string().trim().max(500).optional(),
          pauseUntil: z.string().datetime().optional(),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const store = await loadStore(auth.sub);
      if (store.status !== 'active') {
        throw new AppError(409, ErrorCode.InvalidState, 'Store is not active');
      }
      const before = { status: store.status };
      await db
        .update(retailerStores)
        .set({
          status: 'paused',
          pauseVisibility: req.body.visibility as 'visible' | 'hidden',
          pauseReason: req.body.reason ?? null,
          pauseUntil: req.body.pauseUntil ? new Date(req.body.pauseUntil) : null,
        })
        .where(eq(retailerStores.id, store.id));
      await recordAudit({
        actor: auth,
        action: 'store.pause',
        resourceKind: 'retailer_store',
        resourceId: store.id,
        before,
        after: { status: 'paused', visibility: req.body.visibility },
        requestId: req.id,
      });
      return ok({ storeId: store.id, status: 'paused' });
    },
  );

  // ===== POST /retailer/store/resume =====
  app.post('/store/resume', async (req) => {
    const auth = getAuth(req);
    const store = await loadStore(auth.sub);
    if (store.status !== 'paused') {
      throw new AppError(409, ErrorCode.InvalidState, 'Store is not paused');
    }
    await db
      .update(retailerStores)
      .set({ status: 'active', pauseVisibility: null, pauseReason: null, pauseUntil: null })
      .where(eq(retailerStores.id, store.id));
    await recordAudit({
      actor: auth,
      action: 'store.resume',
      resourceKind: 'retailer_store',
      resourceId: store.id,
      before: { status: 'paused' },
      after: { status: 'active' },
      requestId: req.id,
    });
    return ok({ storeId: store.id, status: 'active' });
  });

  // ===== GET /retailer/notification-prefs =====
  app.get('/notification-prefs', async (req) => {
    const auth = getAuth(req);
    const prefs = await db.query.notificationPreferences.findFirst({
      where: and(
        eq(notificationPreferences.accountKind, 'retailer'),
        eq(notificationPreferences.accountId, auth.sub),
      ),
    });
    // Return defaults if no row yet
    return ok(
      prefs ?? {
        accountKind: 'retailer',
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

  // ===== PUT /retailer/notification-prefs =====
  app.put(
    '/notification-prefs',
    {
      schema: {
        body: z.object({
          pushEnabled: z.boolean().optional(),
          emailEnabled: z.boolean().optional(),
          dailyDigestEnabled: z.boolean().optional(),
          smsEnabled: z.boolean().optional(),
          language: z.string().min(2).max(10).optional(),
          dashboardTiles: z.array(z.string()).optional(),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (req.body.pushEnabled !== undefined) updates.pushEnabled = req.body.pushEnabled;
      if (req.body.emailEnabled !== undefined) updates.emailEnabled = req.body.emailEnabled;
      if (req.body.dailyDigestEnabled !== undefined) updates.dailyDigestEnabled = req.body.dailyDigestEnabled;
      if (req.body.smsEnabled !== undefined) updates.smsEnabled = req.body.smsEnabled;
      if (req.body.language !== undefined) updates.language = req.body.language;
      if (req.body.dashboardTiles !== undefined) updates.dashboardTiles = req.body.dashboardTiles;

      await db
        .insert(notificationPreferences)
        .values({
          accountKind: 'retailer',
          accountId: auth.sub,
          pushEnabled: (req.body.pushEnabled as boolean | undefined) ?? true,
          emailEnabled: (req.body.emailEnabled as boolean | undefined) ?? true,
          dailyDigestEnabled: (req.body.dailyDigestEnabled as boolean | undefined) ?? false,
          smsEnabled: (req.body.smsEnabled as boolean | undefined) ?? false,
          language: req.body.language ?? 'en-IN',
          dashboardTiles: req.body.dashboardTiles ?? null,
        })
        .onConflictDoUpdate({
          target: [notificationPreferences.accountKind, notificationPreferences.accountId],
          set: {
            pushEnabled: req.body.pushEnabled ?? true,
            emailEnabled: req.body.emailEnabled ?? true,
            dailyDigestEnabled: req.body.dailyDigestEnabled ?? false,
            smsEnabled: req.body.smsEnabled ?? false,
            language: req.body.language ?? 'en-IN',
            dashboardTiles: req.body.dashboardTiles ?? null,
            updatedAt: new Date(),
          },
        });

      const prefs = await db.query.notificationPreferences.findFirst({
        where: and(
          eq(notificationPreferences.accountKind, 'retailer'),
          eq(notificationPreferences.accountId, auth.sub),
        ),
      });
      return ok(prefs);
    },
  );

  // ===== GET /retailer/inbox — notification inbox =====
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
      const whereConditions = [
        eq(notifications.recipientKind, 'retailer'),
        eq(notifications.recipientId, auth.sub),
        isNull(notifications.deletedAt),
      ];
      if (unreadOnly) whereConditions.push(isNull(notifications.readAt));

      const rows = await db.query.notifications.findMany({
        where: and(...whereConditions),
        orderBy: desc(notifications.createdAt),
        limit,
      });
      return ok(rows);
    },
  );

  // ===== POST /retailer/inbox/:id/read =====
  app.post(
    '/inbox/:id/read',
    {
      schema: { params: z.object({ id: z.string() }) },
    },
    async (req) => {
      const auth = getAuth(req);
      await db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notifications.id, req.params.id),
            eq(notifications.recipientId, auth.sub),
            isNull(notifications.readAt),
          ),
        );
      return ok({ id: req.params.id, readAt: new Date() });
    },
  );

  // ===== POST /retailer/inbox/read-all =====
  app.post('/inbox/read-all', async (req) => {
    const auth = getAuth(req);
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.recipientKind, 'retailer'),
          eq(notifications.recipientId, auth.sub),
          isNull(notifications.readAt),
          isNull(notifications.deletedAt),
        ),
      );
    return ok({ marked: true });
  });

  // ===== GET /retailer/inbox/unread-count =====
  app.get('/inbox/unread-count', async (req) => {
    const auth = getAuth(req);
    const rows = await db.query.notifications.findMany({
      where: and(
        eq(notifications.recipientKind, 'retailer'),
        eq(notifications.recipientId, auth.sub),
        isNull(notifications.readAt),
        isNull(notifications.deletedAt),
      ),
    });
    return ok({ count: rows.length });
  });
};

export default retailerStoreOpsRoutes;
