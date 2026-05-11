import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import {
  changeRequests,
  kycReverifications,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { newId } from '@/shared/ids.js';
import { retailerAccounts, retailerStores } from '@/db/schema/index.js';

const retailerComplianceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

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

  // ===== GET /retailer/kyc — current reverification cycle =====
  app.get('/kyc', async (req) => {
    const auth = getAuth(req);
    const store = await loadStore(auth.sub);
    const kyc = await db.query.kycReverifications.findFirst({
      where: eq(kycReverifications.storeId, store.id),
      orderBy: desc(kycReverifications.dueAt),
      with: { documents: true },
    });
    return ok(kyc ?? null);
  });

  // ===== POST /retailer/kyc/:id/submit — retailer marks cycle submitted =====
  app.post(
    '/kyc/:id/submit',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const auth = getAuth(req);
      const store = await loadStore(auth.sub);
      const kyc = await db.query.kycReverifications.findFirst({
        where: and(
          eq(kycReverifications.id, req.params.id),
          eq(kycReverifications.storeId, store.id),
        ),
      });
      if (!kyc) throw new AppError(404, ErrorCode.NotFound, 'KYC reverification not found');
      if (kyc.status !== 'pending') {
        throw new AppError(409, ErrorCode.InvalidState, 'KYC cycle already submitted or decided');
      }
      const [updated] = await db
        .update(kycReverifications)
        .set({ status: 'submitted', submittedAt: new Date() })
        .where(eq(kycReverifications.id, kyc.id))
        .returning();
      return ok(updated);
    },
  );

  // ===== GET /retailer/change-requests =====
  app.get('/change-requests', async (req) => {
    const auth = getAuth(req);
    const store = await loadStore(auth.sub);
    const rows = await db.query.changeRequests.findMany({
      where: eq(changeRequests.storeId, store.id),
      orderBy: desc(changeRequests.submittedAt),
    });
    return ok(rows);
  });

  // ===== POST /retailer/change-requests — submit a verified-field change =====
  app.post(
    '/change-requests',
    {
      schema: {
        body: z.object({
          field: z.enum(['legal_name', 'address', 'bank_account', 'gstin']),
          currentValue: z.string().trim().min(1),
          requestedValue: z.string().trim().min(1),
          evidenceUrl: z.string().url().optional(),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const store = await loadStore(auth.sub);

      // One pending request per field at a time
      const existing = await db.query.changeRequests.findFirst({
        where: and(
          eq(changeRequests.storeId, store.id),
          eq(changeRequests.field, req.body.field),
          eq(changeRequests.status, 'pending'),
        ),
      });
      if (existing) {
        throw new AppError(409, ErrorCode.InvalidState, 'A pending request for this field already exists');
      }

      const id = newId('cr');
      await db.insert(changeRequests).values({
        id,
        storeId: store.id,
        field: req.body.field,
        currentValue: req.body.currentValue,
        requestedValue: req.body.requestedValue,
        evidenceUrl: req.body.evidenceUrl ?? null,
      });
      return ok({ id, status: 'pending' });
    },
  );

  // ===== Consumer-facing: POST /consumers/me/data-export (via retailer auth — actually consumer scope) =====
  // NOTE: Consumer-side would normally use consumer auth, but for the retailer-facing compliance
  // demo we expose it under retailer scope for testing. Real consumer app has its own auth domain.

  // ===== GET /retailer/compliance/policy-enforcement — enforcement history for this store =====
  app.get('/compliance/policy-enforcement', async (req) => {
    const { policyEnforcementActions } = await import('@/db/schema/index.js');
    const auth = getAuth(req);
    const store = await loadStore(auth.sub);
    const rows = await db.query.policyEnforcementActions.findMany({
      where: eq(policyEnforcementActions.storeId, store.id),
      orderBy: (t, { desc }) => [desc(t.actedAt)],
    });
    return ok(rows);
  });
};

export default retailerComplianceRoutes;
