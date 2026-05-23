/**
 * Admin returns + refunds + held-items.
 */
import { and, asc, desc, eq, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  heldItems,
  refundDisbursements,
  refunds,
  returns,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { openReturn } from '@/shared/returns/open-return.js';
import { verifyReturn } from '@/shared/returns/verify-return.js';
import { forceFailDisbursement } from '@/shared/refunds/force-fail.js';
import { retryDisbursement } from '@/shared/refunds/retry.js';
import {
  extendHoldingWindow,
  forceDispose,
  markExpired,
} from '@/shared/held-items/dispositions.js';
import type {
  ExtendHoldBody,
  ForceDisposeBody,
  ForceFailBody,
  ListHeldQuery,
  ListRefundsQuery,
  ListReturnsQuery,
  OpenReturnBody,
  VerifyBody,
} from './returns.validators.js';

export async function openReturnHandler(input: {
  orderId: string;
  adminId: string;
  body: z.infer<typeof OpenReturnBody>;
}) {
  const { orderId, adminId, body } = input;
  const r = await openReturn(db, {
    orderId,
    items: body.items,
    counterReturn: false,
    actor: { type: 'admin', id: adminId },
  });
  return ok(r);
}

export async function listReturns(input: { query: z.infer<typeof ListReturnsQuery> }) {
  const conds: SQL[] = [];
  if (input.query.decision) conds.push(eq(returns.storeDecision, input.query.decision));
  const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);
  const rows = await db.query.returns.findMany({
    ...(where && { where }),
    orderBy: desc(returns.openedAt),
    limit: input.query.limit,
    with: { orderItem: { with: { order: true } } },
  });
  return ok(rows);
}

export async function getReturn(id: string) {
  const r = await db.query.returns.findFirst({
    where: eq(returns.id, id),
    with: { orderItem: { with: { order: true } } },
  });
  if (!r) throw new AppError(404, ErrorCode.ReturnNotFound, 'Return not found');
  return ok(r);
}

export async function verifyReturnHandler(input: {
  id: string;
  adminId: string;
  body: z.infer<typeof VerifyBody>;
}) {
  const { id, adminId, body } = input;
  const r = await verifyReturn(db, {
    returnId: id,
    decision: body.decision,
    reasonNote: body.reasonNote,
    rejectPhotos: body.rejectPhotos,
    actor: { type: 'admin', id: adminId },
  });
  return ok(r);
}

export async function listRefunds(input: { query: z.infer<typeof ListRefundsQuery> }) {
  const where = input.query.status ? eq(refunds.status, input.query.status) : undefined;
  const rows = await db.query.refunds.findMany({
    ...(where && { where }),
    orderBy: desc(refunds.createdAt),
    limit: input.query.limit,
    with: {
      lines: true,
      disbursements: { orderBy: asc(refundDisbursements.initiatedAt) },
    },
  });
  return ok(rows);
}

export async function getRefund(id: string) {
  const r = await db.query.refunds.findFirst({
    where: eq(refunds.id, id),
    with: {
      lines: true,
      disbursements: { orderBy: asc(refundDisbursements.initiatedAt) },
    },
  });
  if (!r) throw new AppError(404, ErrorCode.RefundNotFound, 'Refund not found');
  return ok(r);
}

export async function forceFail(input: {
  dId: string;
  adminId: string;
  body: z.infer<typeof ForceFailBody>;
}) {
  const r = await forceFailDisbursement(db, {
    disbursementId: input.dId,
    reason: input.body.reason,
    actor: { type: 'admin', id: input.adminId },
  });
  return ok(r);
}

export async function retryDisb(input: { dId: string; adminId: string }) {
  const r = await retryDisbursement(db, {
    disbursementId: input.dId,
    actor: { type: 'admin', id: input.adminId },
  });
  return ok(r);
}

export async function listHeldItems(input: { query: z.infer<typeof ListHeldQuery> }) {
  const conds: SQL[] = [];
  if (input.query.status) conds.push(eq(heldItems.status, input.query.status));
  if (input.query.storeId) conds.push(eq(heldItems.storeId, input.query.storeId));
  const where =
    conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);
  const rows = await db.query.heldItems.findMany({
    ...(where && { where }),
    orderBy: desc(heldItems.holdingWindowExpiresAt),
    limit: input.query.limit,
    with: {
      return: { with: { orderItem: { with: { order: true } } } },
    },
  });
  return ok(rows);
}

export async function extendHold(input: {
  id: string;
  adminId: string;
  body: z.infer<typeof ExtendHoldBody>;
}) {
  const r = await extendHoldingWindow(db, {
    heldId: input.id,
    daysExtra: input.body.daysExtra,
    reason: input.body.reason,
    adminId: input.adminId,
  });
  return ok(r);
}

export async function forceDisposeHandler(input: {
  id: string;
  adminId: string;
  body: z.infer<typeof ForceDisposeBody>;
}) {
  const r = await forceDispose(db, {
    heldId: input.id,
    disposition: input.body.disposition,
    reason: input.body.reason,
    actor: { type: 'admin', id: input.adminId },
  });
  return ok(r);
}

export async function markExpiredHandler(input: { id: string; adminId: string }) {
  const r = await markExpired(db, input.id, { type: 'admin', id: input.adminId });
  return ok(r);
}

