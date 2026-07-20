import { desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  gstReturnFiles,
  invoiceNumberingRules,
  invoiceSequenceCounters,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { newId } from '@/shared/ids.js';
import { isStorageConfigured, uploadObject } from '@/shared/storage/index.js';
import {
  issueCreditNoteForRefund,
  issueInvoiceForOrder,
} from '@/shared/invoicing/issuance.js';
import { generateGstr1B2cCsv } from '@/shared/invoicing/gst-csv.js';
import { generateTcsReconciliationCsv } from '@/shared/settlement/tcs-csv.js';
import { issueCommissionInvoiceForOrder } from '@/shared/settlement/commission-invoice.js';
import type {
  GenerateGstReturnBody,
  IssueCommissionInvoiceBody,
  IssueCreditNoteBody,
  IssueInvoiceBody,
  UpdateNumberingBody,
} from './invoicing.validators.js';

export async function listInvoiceNumbering() {
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
}

export async function updateInvoiceNumbering(input: {
  legalEntityId: string;
  body: z.infer<typeof UpdateNumberingBody>;
}) {
  const { legalEntityId, body } = input;
  const existing = await db.query.invoiceNumberingRules.findFirst({
    where: eq(invoiceNumberingRules.legalEntityId, legalEntityId),
  });
  if (!existing) {
    throw new AppError(404, ErrorCode.NotFound, 'Invoice numbering rule not found');
  }

  const updates: Partial<typeof invoiceNumberingRules.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.prefix !== undefined) updates.prefix = body.prefix;
  if (body.pattern !== undefined) updates.pattern = body.pattern;
  if (body.resetCycle !== undefined) updates.resetCycle = body.resetCycle;

  await db
    .update(invoiceNumberingRules)
    .set(updates)
    .where(eq(invoiceNumberingRules.legalEntityId, legalEntityId));

  return ok({ legalEntityId, updated: true });
}

export async function listGstReturns() {
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
}

export async function generateGstReturn(input: {
  body: z.infer<typeof GenerateGstReturnBody>;
}) {
  const { body } = input;
  if (body.kind === 'gstr3b') {
    throw new AppError(
      501,
      ErrorCode.InternalError,
      `GST return kind '${body.kind}' not implemented yet`,
    );
  }
  const id = newId('gstr');
  await db
    .insert(gstReturnFiles)
    .values({
      id,
      period: body.period,
      kind: body.kind,
      status: 'generating',
    })
    .onConflictDoNothing();

  try {
    const generated =
      body.kind === 'gstr1'
        ? await generateGstr1B2cCsv({ period: body.period })
        : await generateTcsReconciliationCsv({ period: body.period });
    let downloadUrl: string | null = null;
    if (isStorageConfigured()) {
      const up = await uploadObject(generated.buffer, {
        folder: 'closetx/gst-returns',
        resourceType: 'raw',
        contentType: 'text/csv',
        publicId: `${body.kind}-${body.period}-${id.slice(-8)}`,
      });
      downloadUrl = up.url;
    }
    await db
      .update(gstReturnFiles)
      .set({ status: 'ready', downloadUrl, generatedAt: new Date() })
      .where(eq(gstReturnFiles.id, id));
    return ok({ id, status: 'ready', downloadUrl, rowCount: generated.rowCount });
  } catch (err) {
    await db
      .update(gstReturnFiles)
      .set({ status: 'failed' })
      .where(eq(gstReturnFiles.id, id));
    throw new AppError(
      500,
      ErrorCode.InternalError,
      `Failed to generate GST return: ${(err as Error).message}`,
    );
  }
}

export async function issueCommissionInvoiceManual(input: {
  body: z.infer<typeof IssueCommissionInvoiceBody>;
}) {
  const r = await issueCommissionInvoiceForOrder({ orderId: input.body.orderId });
  return ok(r);
}

export async function issueInvoiceManual(input: { body: z.infer<typeof IssueInvoiceBody> }) {
  const result = await issueInvoiceForOrder({
    orderId: input.body.orderId,
    kind: input.body.kind,
    ...(input.body.heldItemId ? { heldItemId: input.body.heldItemId } : {}),
  });
  return ok(result);
}

export async function issueCreditNoteManual(input: {
  body: z.infer<typeof IssueCreditNoteBody>;
}) {
  const result = await issueCreditNoteForRefund({
    refundId: input.body.refundId,
    reason: input.body.reason,
  });
  return ok(result);
}
