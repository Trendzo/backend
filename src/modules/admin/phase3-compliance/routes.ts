import { asc, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import {
  accountDeletionRequests,
  changeRequests,
  consumers,
  dataExportRequests,
  kycReverifications,
  policyEnforcementActions,
  retailerStores,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { newId } from '@/shared/ids.js';
import { recordAudit } from '@/shared/audit.js';

const adminComplianceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // ===== GET /admin/compliance/kyc — stores with pending/overdue KYC =====
  app.get('/compliance/kyc', async (_req) => {
    const rows = await db.query.kycReverifications.findMany({
      orderBy: asc(kycReverifications.dueAt),
      with: { documents: true },
    });
    return ok(rows);
  });

  // ===== GET /admin/compliance/kyc/:id =====
  app.get(
    '/compliance/kyc/:id',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const row = await db.query.kycReverifications.findFirst({
        where: eq(kycReverifications.id, req.params.id),
        with: { documents: true },
      });
      if (!row) throw new AppError(404, ErrorCode.NotFound, 'KYC reverification not found');
      return ok(row);
    },
  );

  // ===== POST /admin/compliance/kyc/:id/decide — approve or reject =====
  app.post(
    '/compliance/kyc/:id/decide',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          decision: z.enum(['approved', 'rejected']),
          reason: z.string().trim().max(500).optional(),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const kyc = await db.query.kycReverifications.findFirst({
        where: eq(kycReverifications.id, req.params.id),
      });
      if (!kyc) throw new AppError(404, ErrorCode.NotFound, 'KYC reverification not found');
      const now = new Date();
      const [updated] = await db
        .update(kycReverifications)
        .set({
          status: req.body.decision,
          decidedAt: now,
          decidedByAccountId: auth.sub,
          decisionReason: req.body.reason ?? null,
          lastVerifiedAt: req.body.decision === 'approved' ? now : null,
        })
        .where(eq(kycReverifications.id, kyc.id))
        .returning();
      await recordAudit({
        actor: auth,
        action: `kyc.${req.body.decision}`,
        resourceKind: 'kyc_reverification',
        resourceId: kyc.id,
        after: { status: req.body.decision },
        requestId: req.id,
      });
      return ok(updated);
    },
  );

  // ===== GET /admin/compliance/change-requests =====
  app.get(
    '/compliance/change-requests',
    {
      schema: {
        querystring: z.object({
          status: z.enum(['pending', 'approved', 'rejected']).optional(),
        }),
      },
    },
    async (req) => {
      const rows = await db.query.changeRequests.findMany({
        where: req.query.status ? eq(changeRequests.status, req.query.status) : undefined,
        orderBy: desc(changeRequests.submittedAt),
      });
      return ok(rows);
    },
  );

  // ===== POST /admin/compliance/change-requests/:id/decide =====
  app.post(
    '/compliance/change-requests/:id/decide',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          decision: z.enum(['approved', 'rejected']),
          note: z.string().trim().max(500).optional(),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const cr = await db.query.changeRequests.findFirst({
        where: eq(changeRequests.id, req.params.id),
      });
      if (!cr) throw new AppError(404, ErrorCode.NotFound, 'Change request not found');
      if (cr.status !== 'pending') {
        throw new AppError(409, ErrorCode.InvalidState, 'Change request already decided');
      }
      const [updated] = await db
        .update(changeRequests)
        .set({
          status: req.body.decision,
          decidedAt: new Date(),
          decidedByAccountId: auth.sub,
          decisionNote: req.body.note ?? null,
        })
        .where(eq(changeRequests.id, cr.id))
        .returning();
      await recordAudit({
        actor: auth,
        action: `change_request.${req.body.decision}`,
        resourceKind: 'change_request',
        resourceId: cr.id,
        after: { status: req.body.decision },
        requestId: req.id,
      });
      return ok(updated);
    },
  );

  // ===== GET /admin/compliance/policy-enforcement =====
  app.get(
    '/compliance/policy-enforcement',
    {
      schema: {
        querystring: z.object({ storeId: z.string().optional() }),
      },
    },
    async (req) => {
      const rows = await db.query.policyEnforcementActions.findMany({
        where: req.query.storeId
          ? eq(policyEnforcementActions.storeId, req.query.storeId)
          : undefined,
        orderBy: desc(policyEnforcementActions.actedAt),
      });
      return ok(rows);
    },
  );

  // ===== POST /admin/compliance/policy-enforcement — issue enforcement step =====
  app.post(
    '/compliance/policy-enforcement',
    {
      schema: {
        body: z.object({
          storeId: z.string(),
          step: z.enum(['warning_1', 'warning_2', 'warning_3', 'suspension', 'termination', 'lifted']),
          breachKind: z.enum(['acceptance_rate', 'fulfilment_sla', 'dispute_rate', 'return_rate', 'kyc_overdue', 'policy_violation']),
          metric: z.record(z.unknown()).optional(),
          reason: z.string().trim().max(500).optional(),
          liftsActionId: z.string().optional(),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const store = await db.query.retailerStores.findFirst({
        where: eq(retailerStores.id, req.body.storeId),
      });
      if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');

      const id = newId('enf');
      await db.insert(policyEnforcementActions).values({
        id,
        storeId: store.id,
        step: req.body.step,
        breachKind: req.body.breachKind,
        metric: req.body.metric ?? null,
        actedByAccountId: auth.sub,
        reason: req.body.reason ?? null,
        liftsActionId: req.body.liftsActionId ?? null,
      });

      // If suspending / terminating, update store status
      if (req.body.step === 'suspension') {
        await db
          .update(retailerStores)
          .set({ status: 'suspended' })
          .where(eq(retailerStores.id, store.id));
      } else if (req.body.step === 'termination') {
        await db
          .update(retailerStores)
          .set({ status: 'terminated' })
          .where(eq(retailerStores.id, store.id));
      } else if (req.body.step === 'lifted') {
        await db
          .update(retailerStores)
          .set({ status: 'active' })
          .where(eq(retailerStores.id, store.id));
      }

      await recordAudit({
        actor: auth,
        action: `enforcement.${req.body.step}`,
        resourceKind: 'retailer_store',
        resourceId: store.id,
        after: { step: req.body.step },
        requestId: req.id,
      });

      return ok({ id });
    },
  );

  // ===== GET /admin/compliance/data-exports =====
  app.get('/compliance/data-exports', async (_req) => {
    const rows = await db.query.dataExportRequests.findMany({
      orderBy: desc(dataExportRequests.requestedAt),
    });
    return ok(rows);
  });

  // ===== POST /admin/compliance/data-exports/:id/process — mark ready / failed =====
  app.post(
    '/compliance/data-exports/:id/process',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          status: z.enum(['building', 'ready', 'failed']),
          downloadUrl: z.string().url().optional(),
          failureReason: z.string().trim().max(500).optional(),
          expiresInDays: z.number().int().min(1).max(30).default(7),
        }),
      },
    },
    async (req) => {
      const row = await db.query.dataExportRequests.findFirst({
        where: eq(dataExportRequests.id, req.params.id),
      });
      if (!row) throw new AppError(404, ErrorCode.NotFound, 'Data export not found');

      const now = new Date();
      const expiresAt =
        req.body.status === 'ready'
          ? new Date(now.getTime() + req.body.expiresInDays * 24 * 60 * 60 * 1000)
          : null;

      const [updated] = await db
        .update(dataExportRequests)
        .set({
          status: req.body.status,
          readyAt: req.body.status === 'ready' ? now : null,
          downloadUrl: req.body.downloadUrl ?? null,
          failureReason: req.body.failureReason ?? null,
          expiresAt,
        })
        .where(eq(dataExportRequests.id, row.id))
        .returning();

      return ok(updated);
    },
  );

  // ===== GET /admin/compliance/account-deletions =====
  app.get('/compliance/account-deletions', async (_req) => {
    const rows = await db.query.accountDeletionRequests.findMany({
      orderBy: asc(accountDeletionRequests.scheduledFor),
    });
    return ok(rows);
  });

  // ===== POST /admin/compliance/account-deletions/:id/complete =====
  app.post(
    '/compliance/account-deletions/:id/complete',
    {
      schema: { params: z.object({ id: z.string() }) },
    },
    async (req) => {
      const row = await db.query.accountDeletionRequests.findFirst({
        where: eq(accountDeletionRequests.id, req.params.id),
      });
      if (!row) throw new AppError(404, ErrorCode.NotFound, 'Deletion request not found');
      if (row.status === 'completed') {
        throw new AppError(409, ErrorCode.InvalidState, 'Already completed');
      }
      const [updated] = await db
        .update(accountDeletionRequests)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(accountDeletionRequests.id, row.id))
        .returning();

      // Anonymise consumer PII (simplified: overwrite sensitive fields)
      if (updated) {
        await db
          .update(consumers)
          .set({
            email: `deleted+${row.id}@deleted.invalid`,
            phone: '0000000000',
            name: '[Deleted]',
            status: 'closed',
          })
          .where(eq(consumers.id, row.consumerId));
      }
      return ok(updated);
    },
  );
};

export default adminComplianceRoutes;
