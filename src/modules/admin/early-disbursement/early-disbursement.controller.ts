import { desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { bankAccounts, earlyDisbursementRequests } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { runCycle } from '@/shared/settlement/run-cycle.js';
import { notifyStoreAccounts } from '@/shared/notify-store.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type { ListDecisionsQuery, RejectBody } from './early-disbursement.validators.js';

type Auth = AccessTokenPayload;

function shapeRequest(
  r: typeof earlyDisbursementRequests.$inferSelect & {
    store?: { legalName: string } | null;
  },
) {
  return {
    id: r.id,
    storeId: r.storeId,
    storeName: r.store?.legalName ?? r.storeId,
    amountPaise: r.amountPaise,
    reason: r.reason,
    status: r.status,
    requestedAt: r.requestedAt.toISOString(),
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    decisionNote: r.decisionNote,
  };
}

export async function listDecisions(input: { query: z.infer<typeof ListDecisionsQuery> }) {
  const rows = await db.query.earlyDisbursementRequests.findMany({
    where: input.query.status
      ? eq(earlyDisbursementRequests.status, input.query.status)
      : undefined,
    orderBy: desc(earlyDisbursementRequests.requestedAt),
    limit: input.query.limit,
    with: { store: true },
  });

  return ok(rows.map(shapeRequest));
}

export async function approveDecision(input: { id: string; auth: Auth }) {
  const { id, auth } = input;
  const r = await db.query.earlyDisbursementRequests.findFirst({
    where: eq(earlyDisbursementRequests.id, id),
  });
  if (!r) throw new AppError(404, ErrorCode.NotFound, 'Request not found');
  if (r.status !== 'pending') {
    throw new AppError(409, ErrorCode.InvalidState, 'Request is not pending');
  }

  await db
    .update(earlyDisbursementRequests)
    .set({ status: 'approved', decidedAt: new Date(), decidedByAccountId: auth.sub })
    .where(eq(earlyDisbursementRequests.id, id));

  return ok({ id, status: 'approved' });
}

/**
 * §18 — execute an off-cycle payout for an approved early-disbursement request.
 * Cycle window: [lastPaidCycleEnd, now).
 */
export async function executeDecision(input: { id: string; auth: Auth }) {
  const { id, auth } = input;
  const r = await db.query.earlyDisbursementRequests.findFirst({
    where: eq(earlyDisbursementRequests.id, id),
  });
  if (!r) throw new AppError(404, ErrorCode.NotFound, 'Request not found');
  if (r.status !== 'approved') {
    throw new AppError(409, ErrorCode.InvalidState, 'Request must be approved before execute');
  }
  // Find primary bank account for store.
  const bank = await db.query.bankAccounts.findFirst({
    where: eq(bankAccounts.storeId, r.storeId),
  });
  if (!bank) throw new AppError(409, ErrorCode.InvalidState, 'No bank account on file');
  const now = new Date();
  // Cycle window: last 30 days as a sensible default for off-cycle.
  const cycleStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const result = await runCycle({
    storeId: r.storeId,
    cycleStart,
    cycleEnd: now,
    bankAccountId: bank.id,
    actor: { type: 'admin', id: auth.sub },
  });
  await notifyStoreAccounts({
    storeId: r.storeId,
    kind: 'payout',
    title: 'Early disbursement approved',
    body: `Off-cycle payout ${result.payoutId} created.`,
    deepLink: `/payouts/${result.payoutId}`,
    payload: { payoutId: result.payoutId, source: 'early_disbursement', requestId: id },
  });
  return ok({ requestId: id, payoutId: result.payoutId, alreadyExisted: result.alreadyExisted });
}

export async function rejectDecision(input: {
  id: string;
  auth: Auth;
  body: z.infer<typeof RejectBody>;
}) {
  const { id, auth, body } = input;
  const r = await db.query.earlyDisbursementRequests.findFirst({
    where: eq(earlyDisbursementRequests.id, id),
  });
  if (!r) throw new AppError(404, ErrorCode.NotFound, 'Request not found');
  if (r.status !== 'pending') {
    throw new AppError(409, ErrorCode.InvalidState, 'Request is not pending');
  }

  await db
    .update(earlyDisbursementRequests)
    .set({
      status: 'rejected',
      decidedAt: new Date(),
      decidedByAccountId: auth.sub,
      decisionNote: body.reason,
    })
    .where(eq(earlyDisbursementRequests.id, id));

  return ok({ id, status: 'rejected' });
}
