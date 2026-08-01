/**
 * The single writer of `refunds.status` after the header is created.
 *
 * Before this module the roll-up was hand-rolled in eight places and only one of
 * them (retry.ts) was correct — the others hardcoded a status without looking at
 * sibling disbursements, so a mixed-tender refund whose wallet leg succeeded and
 * whose gateway leg bounced could still read 'succeeded', and `completedAt` was
 * never cleared when a refund regressed out of a terminal state.
 *
 * Roll-up is computed over the LEAF disbursements. A leaf is one that no other row
 * names via `previousDisbursementId` — i.e. it has not been superseded by a retry.
 * Counting superseded legs would let a force-failed leg hold a refund at 'failed'
 * forever even after its replacement succeeded.
 */
import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { refundDisbursements, refunds } from '@/db/schema/index.js';

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];
export type DbOrTx = typeof Db | Tx;

export type RefundStatus =
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'partially_disbursed'
  | 'failed';

export type DisbursementLeafInput = {
  id: string;
  status: 'pending' | 'succeeded' | 'failed';
  previousDisbursementId: string | null;
};

/** Disbursements not superseded by a later retry in the chain. */
export function leavesOf<T extends DisbursementLeafInput>(all: T[]): T[] {
  const superseded = new Set(
    all.map((d) => d.previousDisbursementId).filter((v): v is string => v !== null),
  );
  return all.filter((d) => !superseded.has(d.id));
}

/**
 * Pure decider — no DB, so the truth table is unit-testable.
 *
 *   no leaves                        → pending             (header written, no legs yet)
 *   every leaf succeeded             → succeeded
 *   every leaf failed                → failed
 *   some succeeded, some not         → partially_disbursed (part of the money landed)
 *   none succeeded, at least one in flight → processing
 */
export function decideRefundStatus(all: DisbursementLeafInput[]): RefundStatus {
  const leaves = leavesOf(all);
  if (leaves.length === 0) return 'pending';
  const succeeded = leaves.filter((d) => d.status === 'succeeded').length;
  const failed = leaves.filter((d) => d.status === 'failed').length;
  if (succeeded === leaves.length) return 'succeeded';
  if (failed === leaves.length) return 'failed';
  if (succeeded > 0) return 'partially_disbursed';
  return 'processing';
}

/**
 * Re-read this refund's disbursements and write the derived status.
 *
 * Safe with either a transaction handle or the pooled client — call it with `tx`
 * from inside the transaction that flipped a leg so the read sees that flip.
 * `completedAt` is stamped on ENTRY to a terminal status (preserved on repeat
 * calls) and cleared when the refund regresses back out of one.
 */
export async function rollUpRefundStatus(dbx: DbOrTx, refundId: string): Promise<RefundStatus> {
  const rows = await dbx.query.refundDisbursements.findMany({
    where: eq(refundDisbursements.refundId, refundId),
    columns: { id: true, status: true, previousDisbursementId: true },
  });
  const status = decideRefundStatus(rows);
  const isTerminal = status === 'succeeded' || status === 'failed';

  const current = await dbx.query.refunds.findFirst({
    where: eq(refunds.id, refundId),
    columns: { completedAt: true },
  });
  const completedAt = isTerminal ? (current?.completedAt ?? new Date()) : null;

  await dbx.update(refunds).set({ status, completedAt }).where(eq(refunds.id, refundId));
  return status;
}
