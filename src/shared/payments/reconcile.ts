/**
 * §15 PC1 — settlement-file ↔ payments table reconciler.
 *
 * Input: a `payment_settlements` row (already inserted with its entries) + the cycle
 * window. Output: every `payment_settlement_entries` row gets a `match_status` and
 * `matched_payment_id`; any cross-side mismatch becomes a `payment_recon_discrepancies`
 * row. Aggregate counters land on `payment_settlements.summary`.
 *
 * Matching rule: exact `payments.gateway_ref` ⇄ `entry.gateway_ref`. Amounts must
 * also match (else `amount_mismatch`). Status check: settlement implies the payment
 * captured successfully — if our `payments.status` is `failed`/`pending`, that's a
 * `status_mismatch`. Reverse pass: any payment with `status='succeeded'` and `settled_at`
 * in the cycle that has no entry → `missing_in_settlement`.
 */
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import {
  payments,
  paymentReconDiscrepancies,
  paymentSettlementEntries,
  paymentSettlements,
} from '@/db/schema/index.js';
import { IdPrefix, newId } from '@/shared/ids.js';

export type ReconcileSummary = {
  totalEntries: number;
  matched: number;
  amountMismatch: number;
  missingInCapture: number;
  missingInSettlement: number;
  statusMismatch: number;
  duplicate: number;
  totalAmountPaise: number;
};

/**
 * Run reconciliation against an already-uploaded settlement. Idempotent — re-running
 * overwrites entry match_status and replaces open discrepancies for this settlement.
 */
export async function reconcileSettlement(settlementId: string): Promise<ReconcileSummary> {
  const settlement = await db.query.paymentSettlements.findFirst({
    where: eq(paymentSettlements.id, settlementId),
  });
  if (!settlement) throw new Error(`Settlement ${settlementId} not found`);

  const entries = await db.query.paymentSettlementEntries.findMany({
    where: eq(paymentSettlementEntries.settlementId, settlementId),
  });

  const refs = Array.from(new Set(entries.map((e) => e.gatewayRef)));
  const matchedPayments = refs.length
    ? await db.query.payments.findMany({
        where: inArray(payments.gatewayRef, refs),
      })
    : [];
  const paymentByRef = new Map(matchedPayments.map((p) => [p.gatewayRef!, p]));

  const summary: ReconcileSummary = {
    totalEntries: entries.length,
    matched: 0,
    amountMismatch: 0,
    missingInCapture: 0,
    missingInSettlement: 0,
    statusMismatch: 0,
    duplicate: 0,
    totalAmountPaise: entries.reduce((acc, e) => acc + e.amountPaise, 0),
  };

  // Pre-pass: detect duplicates across already-reconciled settlements (other cycles).
  const dupRows = refs.length
    ? await db
        .select({
          gatewayRef: paymentSettlementEntries.gatewayRef,
          c: sql<number>`COUNT(*)::int`,
        })
        .from(paymentSettlementEntries)
        .where(inArray(paymentSettlementEntries.gatewayRef, refs))
        .groupBy(paymentSettlementEntries.gatewayRef)
    : [];
  const duplicateRefs = new Set(dupRows.filter((r) => Number(r.c) > 1).map((r) => r.gatewayRef));

  // Clear stale open discrepancies for re-runs.
  await db
    .delete(paymentReconDiscrepancies)
    .where(
      and(
        eq(paymentReconDiscrepancies.settlementId, settlementId),
        sql`${paymentReconDiscrepancies.resolvedAt} IS NULL`,
      ),
    );

  const discrepancies: Array<typeof paymentReconDiscrepancies.$inferInsert> = [];

  for (const entry of entries) {
    const p = paymentByRef.get(entry.gatewayRef);
    let nextStatus: typeof paymentSettlementEntries.$inferSelect.matchStatus = 'pending';
    let matchedPaymentId: string | null = null;

    if (duplicateRefs.has(entry.gatewayRef)) {
      nextStatus = 'duplicate';
      summary.duplicate += 1;
      discrepancies.push({
        id: newId(IdPrefix.PaymentReconDiscrepancy),
        settlementId,
        entryId: entry.id,
        paymentId: p?.id ?? null,
        kind: 'duplicate',
        details: { gatewayRef: entry.gatewayRef },
      });
    } else if (!p) {
      nextStatus = 'missing_in_capture';
      summary.missingInCapture += 1;
      discrepancies.push({
        id: newId(IdPrefix.PaymentReconDiscrepancy),
        settlementId,
        entryId: entry.id,
        paymentId: null,
        kind: 'missing_in_capture',
        details: { gatewayRef: entry.gatewayRef, amountPaise: entry.amountPaise },
      });
    } else if (p.amountPaise !== entry.amountPaise) {
      nextStatus = 'amount_mismatch';
      matchedPaymentId = p.id;
      summary.amountMismatch += 1;
      discrepancies.push({
        id: newId(IdPrefix.PaymentReconDiscrepancy),
        settlementId,
        entryId: entry.id,
        paymentId: p.id,
        kind: 'amount_mismatch',
        details: {
          gatewayRef: entry.gatewayRef,
          capturedPaise: p.amountPaise,
          settledPaise: entry.amountPaise,
          deltaPaise: entry.amountPaise - p.amountPaise,
        },
      });
    } else if (p.status !== 'succeeded') {
      nextStatus = 'status_mismatch';
      matchedPaymentId = p.id;
      summary.statusMismatch += 1;
      discrepancies.push({
        id: newId(IdPrefix.PaymentReconDiscrepancy),
        settlementId,
        entryId: entry.id,
        paymentId: p.id,
        kind: 'status_mismatch',
        details: {
          gatewayRef: entry.gatewayRef,
          capturedStatus: p.status,
          settlementExpects: 'succeeded',
        },
      });
    } else {
      nextStatus = 'matched';
      matchedPaymentId = p.id;
      summary.matched += 1;
    }

    await db
      .update(paymentSettlementEntries)
      .set({ matchStatus: nextStatus, matchedPaymentId })
      .where(eq(paymentSettlementEntries.id, entry.id));
  }

  // Reverse pass: succeeded payments in cycle window with no settlement entry.
  const cycleSucceeded = await db.query.payments.findMany({
    where: and(
      eq(payments.status, 'succeeded'),
      gte(payments.settledAt, settlement.cycleStart),
      lt(payments.settledAt, settlement.cycleEnd),
    ),
  });
  const settledRefs = new Set(entries.map((e) => e.gatewayRef));
  for (const p of cycleSucceeded) {
    if (!p.gatewayRef || settledRefs.has(p.gatewayRef)) continue;
    summary.missingInSettlement += 1;
    discrepancies.push({
      id: newId(IdPrefix.PaymentReconDiscrepancy),
      settlementId,
      entryId: null,
      paymentId: p.id,
      kind: 'missing_in_settlement',
      details: {
        gatewayRef: p.gatewayRef,
        amountPaise: p.amountPaise,
        orderId: p.orderId,
      },
    });
  }

  if (discrepancies.length > 0) {
    await db.insert(paymentReconDiscrepancies).values(discrepancies);
  }

  const cleanlyMatched = summary.matched === summary.totalEntries && summary.missingInSettlement === 0;
  await db
    .update(paymentSettlements)
    .set({
      summary: summary as unknown as Record<string, number>,
      status: cleanlyMatched ? 'reconciled' : 'partial',
      reconciledAt: new Date(),
    })
    .where(eq(paymentSettlements.id, settlementId));

  return summary;
}
