import { desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import { gstReturnFiles, invoiceNumberingRules, invoiceSequenceCounters } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { requireAuth } from '@/shared/auth/middleware.js';
import { newId } from '@/shared/ids.js';

const adminInvoicingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // ===== GET /admin/invoice-numbering — per-legal-entity invoice numbering config =====
  app.get('/invoice-numbering', async () => {
    const rules = await db.query.invoiceNumberingRules.findMany({
      orderBy: (t, { asc }) => [asc(t.legalEntityId)],
    });

    // For each rule, find the latest sequence counter
    const withSeq = await Promise.all(
      rules.map(async (r) => {
        const latestCounter = await db.query.invoiceSequenceCounters.findFirst({
          where: eq(invoiceSequenceCounters.legalEntityId, r.legalEntityId),
          orderBy: (t, { desc: d }) => [d(t.lastSeq)],
        });
        return {
          legalEntityId: r.legalEntityId,
          legalEntityName: r.legalEntityName,
          prefix: r.prefix,
          pattern: r.pattern,
          nextSequence: (latestCounter?.lastSeq ?? 0) + 1,
          resetCycle: r.resetCycle,
        };
      }),
    );

    return ok(withSeq);
  });

  // ===== PUT /admin/invoice-numbering/:legalEntityId — update config =====
  app.put(
    '/invoice-numbering/:legalEntityId',
    {
      schema: {
        params: z.object({ legalEntityId: z.string() }),
        body: z.object({
          prefix: z.string().trim().min(1).max(20).optional(),
          pattern: z.string().trim().min(1).max(100).optional(),
          resetCycle: z.enum(['never', 'fiscal_year', 'monthly']).optional(),
        }),
      },
    },
    async (req) => {
      const existing = await db.query.invoiceNumberingRules.findFirst({
        where: eq(invoiceNumberingRules.legalEntityId, req.params.legalEntityId),
      });
      if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Invoice numbering rule not found');

      const updates: Partial<typeof invoiceNumberingRules.$inferInsert> = { updatedAt: new Date() };
      if (req.body.prefix !== undefined) updates.prefix = req.body.prefix;
      if (req.body.pattern !== undefined) updates.pattern = req.body.pattern;
      if (req.body.resetCycle !== undefined) updates.resetCycle = req.body.resetCycle;

      await db
        .update(invoiceNumberingRules)
        .set(updates)
        .where(eq(invoiceNumberingRules.legalEntityId, req.params.legalEntityId));

      return ok({ legalEntityId: req.params.legalEntityId, updated: true });
    },
  );

  // ===== GET /admin/gst-returns — GST return file records =====
  app.get('/gst-returns', async () => {
    const files = await db.query.gstReturnFiles.findMany({
      orderBy: [desc(gstReturnFiles.period)],
    });

    return ok(
      files.map((f) => ({
        id: f.id,
        period: f.period,
        kind: f.kind,
        generatedAt: f.generatedAt ? f.generatedAt.toISOString() : null,
        downloadUrl: f.downloadUrl,
        status: f.status,
      })),
    );
  });

  // ===== POST /admin/gst-returns/generate — trigger file generation =====
  app.post(
    '/gst-returns/generate',
    {
      schema: {
        body: z.object({
          period: z.string().regex(/^\d{4}-\d{2}$/, 'Period must be YYYY-MM'),
          kind: z.enum(['gstr1', 'gstr3b', 'tcs_reconciliation']),
        }),
      },
    },
    async (req) => {
      const id = newId('gstr');
      await db
        .insert(gstReturnFiles)
        .values({
          id,
          period: req.body.period,
          kind: req.body.kind,
          status: 'pending',
        })
        .onConflictDoNothing();

      return ok({ id, status: 'pending' });
    },
  );
};

export default adminInvoicingRoutes;
