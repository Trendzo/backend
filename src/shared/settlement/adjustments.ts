/**
 * §18 — Ops debit/credit adjustments. Each row is consumed by the next runCycle for the store.
 */
import { db } from '@/db/client.js';
import { payoutAdjustments } from '@/db/schema/index.js';
import { newId } from '@/shared/ids.js';

export async function recordAdjustment(input: {
  storeId: string;
  direction: 'debit' | 'credit';
  amountPaise: number | bigint;
  reason: string;
  adminId: string;
  kind?: 'manual' | 'dispute_liability';
  sourceIssueId?: string;
}): Promise<{ adjustmentId: string }> {
  const id = newId('adj');
  await db.insert(payoutAdjustments).values({
    id,
    storeId: input.storeId,
    direction: input.direction,
    kind: input.kind ?? 'manual',
    amountPaise: typeof input.amountPaise === 'bigint' ? input.amountPaise : BigInt(input.amountPaise),
    reason: input.reason,
    sourceIssueId: input.sourceIssueId ?? null,
    createdByAdminId: input.adminId,
  });
  return { adjustmentId: id };
}
