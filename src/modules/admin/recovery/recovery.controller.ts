import { desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { postPayoutRecoveries } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import type { ListRecoveriesQuery } from './recovery.validators.js';

function shapeRow(
  r: typeof postPayoutRecoveries.$inferSelect & {
    store?: { legalName: string; id: string } | null;
  },
) {
  return {
    id: r.id,
    refundId: r.refundId,
    orderId: r.orderId,
    retailerId: r.store?.id ?? r.storeId,
    retailerName: r.store?.legalName ?? r.storeId,
    payoutCycleId: r.payoutCycleId ?? null,
    refundedPaise: r.refundedPaise,
    plannedDebitPaise: r.plannedDebitPaise,
    status: r.status,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
    scheduledFor: r.scheduledFor.toISOString(),
    settledAt: r.settledAt ? r.settledAt.toISOString() : null,
  };
}

export async function listRecoveries(input: {
  query: z.infer<typeof ListRecoveriesQuery>;
}) {
  const rows = await db.query.postPayoutRecoveries.findMany({
    where: input.query.status
      ? eq(postPayoutRecoveries.status, input.query.status)
      : undefined,
    orderBy: desc(postPayoutRecoveries.createdAt),
    limit: input.query.limit,
    with: { store: true },
  });
  return ok(rows.map(shapeRow));
}

export async function cancelRecovery(id: string) {
  const r = await db.query.postPayoutRecoveries.findFirst({
    where: eq(postPayoutRecoveries.id, id),
  });
  if (!r) throw new AppError(404, ErrorCode.NotFound, 'Recovery row not found');
  if (r.status !== 'planned') {
    throw new AppError(409, ErrorCode.InvalidState, 'Can only cancel planned recoveries');
  }

  await db
    .update(postPayoutRecoveries)
    .set({ status: 'cancelled' })
    .where(eq(postPayoutRecoveries.id, id));

  return ok({ id, status: 'cancelled' });
}
