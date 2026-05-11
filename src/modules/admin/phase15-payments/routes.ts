import { desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { db } from '@/db/client.js';
import { payments } from '@/db/schema/index.js';
import { ok } from '@/shared/http/envelope.js';
import { requireAuth } from '@/shared/auth/middleware.js';

const adminPaymentsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // ===== GET /admin/payment-failures — failed payment captures =====
  app.get('/payment-failures', async () => {
    const rows = await db.query.payments.findMany({
      where: eq(payments.status, 'failed'),
      orderBy: desc(payments.initiatedAt),
      limit: 100,
      with: { order: true },
    });

    return ok(
      rows.map((p) => ({
        id: p.id,
        orderId: p.orderId,
        consumerEmail: p.order?.consumerEmailSnap ?? '—',
        amountPaise: p.amountPaise,
        method: p.method,
        failureCode: '',
        failureMessage: 'Payment capture failed',
        attemptCount: 1,
        reservationStillHeld: p.order?.status === 'pending',
        failedAt: (p.settledAt ?? p.initiatedAt).toISOString(),
      })),
    );
  });

  // ===== GET /admin/payment-reconciliation — placeholder (needs gateway files) =====
  app.get('/payment-reconciliation', async () => ok([]));
};

export default adminPaymentsRoutes;
