/**
 * Bind cash that was already handed over to the refund that owes it.
 *
 * The driver hands cash at the doorstep when collecting the returned goods — which is
 * BEFORE the refund exists, because the store has not verified the return yet. So the
 * handover is recorded on its own, unallocated, and the refund later CLAIMS it:
 *
 *   t2  driver hands ₹300      → refund_cash_handovers row (unallocated)
 *   t4  store accepts          → refund created
 *   t5  (same transaction)     → cash leg 'succeeded', settledAt = handedAt
 *
 * Allocation is derived, never counted: `SUM(amount_paise)` over the disbursements
 * pointing at the handover, read under a `FOR UPDATE` lock on the handover row. That
 * lock is load-bearing — one pickup task can carry several returns and `verifyReturn`
 * refunds them ONE AT A TIME, so two refunds legitimately race for one handover.
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { refundCashHandovers, refundDisbursements } from '@/db/schema/index.js';

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

export type CashClaim = { handoverId: string; amountPaise: number; handedAt: Date };

export async function claimCashHandover(
  tx: Tx,
  input: { orderId: string; returnIds: string[]; maxPaise: number },
): Promise<CashClaim[]> {
  if (input.maxPaise <= 0) return [];

  // Lock this order's handovers for the duration of the transaction. Small set, and
  // it is the serialisation point between two concurrent per-return refunds.
  const rows = await tx
    .select()
    .from(refundCashHandovers)
    .where(eq(refundCashHandovers.orderId, input.orderId))
    .orderBy(refundCashHandovers.handedAt)
    .for('update');

  // Match by return overlap in JS rather than a jsonb containment operator — same
  // style as the reverse-pickup delivery path, and the set is tiny.
  const wanted = new Set(input.returnIds);
  const candidates = rows.filter((h) => (h.returnIds ?? []).some((id) => wanted.has(id)));
  if (candidates.length === 0) return [];

  const claims: CashClaim[] = [];
  let remaining = input.maxPaise;

  for (const h of candidates) {
    if (remaining <= 0) break;
    const allocatedRows = await tx
      .select({ amountPaise: refundDisbursements.amountPaise })
      .from(refundDisbursements)
      .where(
        and(
          eq(refundDisbursements.cashHandoverId, h.id),
          ne(refundDisbursements.status, 'failed'),
        ),
      );
    const allocated = allocatedRows.reduce((s, d) => s + d.amountPaise, 0);
    const free = Math.max(h.amountPaise - allocated, 0);
    if (free <= 0) continue;

    const take = Math.min(free, remaining);
    claims.push({ handoverId: h.id, amountPaise: take, handedAt: h.handedAt });
    remaining -= take;
  }

  return claims;
}

/**
 * Cash handed for these returns that no refund has claimed yet — the money the
 * platform paid out on goods it may not get back. Surfaced to admins when a return
 * whose cash was already handed is later rejected.
 */
export async function unclaimedHandoversForReturns(
  dbx: typeof Db,
  returnIds: string[],
): Promise<Array<{ id: string; amountPaise: number; unclaimedPaise: number }>> {
  if (returnIds.length === 0) return [];
  const rows = await dbx.query.refundCashHandovers.findMany({
    columns: { id: true, amountPaise: true, returnIds: true },
  });
  const wanted = new Set(returnIds);
  const matching = rows.filter((h) => (h.returnIds ?? []).some((id) => wanted.has(id)));
  if (matching.length === 0) return [];

  const allocations = await dbx
    .select({ id: refundDisbursements.cashHandoverId, amountPaise: refundDisbursements.amountPaise })
    .from(refundDisbursements)
    .where(
      and(
        inArray(
          refundDisbursements.cashHandoverId,
          matching.map((h) => h.id),
        ),
        ne(refundDisbursements.status, 'failed'),
      ),
    );

  return matching
    .map((h) => {
      const allocated = allocations
        .filter((a) => a.id === h.id)
        .reduce((s, a) => s + a.amountPaise, 0);
      return {
        id: h.id,
        amountPaise: h.amountPaise,
        unclaimedPaise: Math.max(h.amountPaise - allocated, 0),
      };
    })
    .filter((h) => h.unclaimedPaise > 0);
}
