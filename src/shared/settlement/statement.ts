/**
 * §18 — Monthly billing statement close.
 *
 * For each store that has payouts whose cycleEnd falls in the requested period (YYYY-MM),
 * aggregate the cycle rollups into a `billing_statements` row and render a PDF.
 * Idempotent on (storeId, period) via the unique index.
 */
import { and, eq, gte, lt } from 'drizzle-orm';
import { db } from '@/db/client.js';
import {
  billingStatements,
  invoices,
  orders as ordersTable,
  payoutAdjustments,
  payouts,
  retailerStores,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { newId } from '@/shared/ids.js';
import { isStorageConfigured, uploadObject } from '@/shared/storage/index.js';
import { renderInvoicePdf } from '@/shared/invoicing/pdf.js';

export type CloseResult = {
  period: string;
  statements: Array<{
    storeId: string;
    statementId: string;
    alreadyExisted: boolean;
    netPayoutPaise: bigint;
  }>;
};

export async function runMonthlyClose(input: { period: string }): Promise<CloseResult> {
  const match = /^(\d{4})-(\d{2})$/.exec(input.period);
  if (!match) {
    throw new AppError(422, ErrorCode.ValidationError, 'period must be YYYY-MM');
  }
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const periodStart = new Date(Date.UTC(year, month, 1));
  const periodEnd = new Date(Date.UTC(year, month + 1, 1));

  // Pull every payout whose cycleEnd lies inside the period.
  const payoutRows = await db
    .select()
    .from(payouts)
    .where(and(gte(payouts.cycleEnd, periodStart), lt(payouts.cycleEnd, periodEnd)));

  // Group by storeId.
  const byStore = new Map<string, typeof payoutRows>();
  for (const p of payoutRows) {
    const arr = byStore.get(p.storeId) ?? [];
    arr.push(p);
    byStore.set(p.storeId, arr);
  }

  const statements: CloseResult['statements'] = [];

  for (const [storeId, cyclePayouts] of byStore.entries()) {
    const store = await db.query.retailerStores.findFirst({
      where: eq(retailerStores.id, storeId),
    });
    if (!store) continue;

    // Aggregate.
    let commissionPaise = 0n;
    let commissionTaxPaise = 0n;
    let tcsPaise = 0n;
    let disputeLiabilitiesPaise = 0n;
    let adjustmentsPaise = 0n;
    let netPayoutPaise = 0n;
    for (const p of cyclePayouts) {
      commissionPaise += p.commissionPaise;
      commissionTaxPaise += p.commissionTaxPaise;
      disputeLiabilitiesPaise += p.disputeHoldPaise;
      adjustmentsPaise += p.adjustmentsPaise;
      netPayoutPaise += p.netPaise;
    }
    // Pull adjudicated dispute outcomes attached to any payout in this period.
    // payout-math already split them out of `payouts.adjustmentsPaise`, so reading
    // payoutAdjustments here gives us a clean separate-liability total per §19.
    const periodPayoutIds = cyclePayouts.map((p) => p.id);
    const payoutIdSet = new Set(periodPayoutIds);
    const disputeAdjRows =
      periodPayoutIds.length === 0
        ? []
        : await db
            .select({
              direction: payoutAdjustments.direction,
              amountPaise: payoutAdjustments.amountPaise,
              payoutId: payoutAdjustments.payoutId,
            })
            .from(payoutAdjustments)
            .where(
              and(
                eq(payoutAdjustments.storeId, storeId),
                eq(payoutAdjustments.kind, 'dispute_liability'),
              ),
            );
    let disputeAdjudicatedPaise = 0n;
    for (const a of disputeAdjRows) {
      if (!a.payoutId || !payoutIdSet.has(a.payoutId)) continue;
      // Liability = debit amount (positive). Credit would mean store gets money back; rare.
      const liability = a.direction === 'debit' ? a.amountPaise : -a.amountPaise;
      disputeAdjudicatedPaise += liability;
    }
    disputeLiabilitiesPaise += disputeAdjudicatedPaise;

    // Sum TCS from orders delivered in the period for this store.
    const ordersForStore = await db
      .select({
        tcsRateBpSnap: ordersTable.tcsRateBpSnap,
        itemsSubtotalPaise: ordersTable.itemsSubtotalPaise,
      })
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.storeId, storeId),
          eq(ordersTable.status, 'delivered'),
          gte(ordersTable.deliveredAt, periodStart),
          lt(ordersTable.deliveredAt, periodEnd),
        ),
      );
    for (const o of ordersForStore) {
      tcsPaise += BigInt(Math.floor((o.itemsSubtotalPaise * o.tcsRateBpSnap) / 10_000));
    }

    // Add-on fees: from existing invoices for the store in period (taxable - subtotal not applicable);
    // simplest accurate signal — sum delivery+handling+convenience from orders.
    const addOnRows = await db
      .select({
        delivery: ordersTable.deliveryFeePaise,
        handling: ordersTable.handlingFeePaise,
        convenience: ordersTable.convenienceFeePaise,
      })
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.storeId, storeId),
          eq(ordersTable.status, 'delivered'),
          gte(ordersTable.deliveredAt, periodStart),
          lt(ordersTable.deliveredAt, periodEnd),
        ),
      );
    let addOnFeesPaise = 0n;
    for (const r of addOnRows) {
      addOnFeesPaise += BigInt(r.delivery + r.handling + r.convenience);
    }

    // Upsert statement (idempotent via unique index).
    const existing = await db.query.billingStatements.findFirst({
      where: and(eq(billingStatements.storeId, storeId), eq(billingStatements.period, input.period)),
    });
    let statementId: string;
    let alreadyExisted = false;
    if (existing) {
      statementId = existing.id;
      alreadyExisted = true;
      await db
        .update(billingStatements)
        .set({
          commissionPaise,
          commissionTaxPaise,
          addOnFeesPaise,
          tcsPaise,
          disputeLiabilitiesPaise,
          adjustmentsPaise,
          netPayoutPaise,
          status: 'closed',
          closedAt: new Date(),
        })
        .where(eq(billingStatements.id, statementId));
    } else {
      statementId = newId('bst');
      await db.insert(billingStatements).values({
        id: statementId,
        storeId,
        legalEntityId: store.legalEntityId,
        period: input.period,
        commissionPaise,
        commissionTaxPaise,
        addOnFeesPaise,
        tcsPaise,
        disputeLiabilitiesPaise,
        adjustmentsPaise,
        netPayoutPaise,
        status: 'closed',
        closedAt: new Date(),
      });
    }

    statements.push({ storeId, statementId, alreadyExisted, netPayoutPaise });

    // Render PDF (post-commit best-effort).
    setImmediate(() => {
      void renderAndUploadStatementPdf({
        statementId,
        period: input.period,
        store,
        commissionPaise,
        commissionTaxPaise,
        addOnFeesPaise,
        tcsPaise,
        disputeLiabilitiesPaise,
        adjustmentsPaise,
        netPayoutPaise,
        orderCount: ordersForStore.length,
      }).catch((err) => {
        console.error(
          `[settlement] statement PDF render failed for ${statementId}: ${(err as Error).message}`,
        );
      });
    });
  }

  return { period: input.period, statements };
}

async function renderAndUploadStatementPdf(input: {
  statementId: string;
  period: string;
  store: typeof retailerStores.$inferSelect;
  commissionPaise: bigint;
  commissionTaxPaise: bigint;
  addOnFeesPaise: bigint;
  tcsPaise: bigint;
  disputeLiabilitiesPaise: bigint;
  adjustmentsPaise: bigint;
  netPayoutPaise: bigint;
  orderCount: number;
}): Promise<void> {
  if (!isStorageConfigured()) return;
  const n = (b: bigint) => Number(b);
  const buffer = await renderInvoicePdf({
    title: 'MONTHLY BILLING STATEMENT',
    number: `STMT-${input.period}-${input.store.id.slice(-6)}`,
    issuedAt: new Date(),
    store: {
      legalName: 'ClosetX',
      address: 'ClosetX Platform Services',
      gstin: 'PLATFORM-GSTIN',
      stateCode: input.store.stateCode,
    },
    consumer: {
      name: input.store.legalName,
      billingAddress: input.store.address,
      gstin: input.store.gstin,
    },
    lines: [
      {
        description: `Commission (period ${input.period}, ${input.orderCount} delivered orders)`,
        hsn: '9985',
        qty: 1,
        unitPricePaise: n(input.commissionPaise),
        gstRateBp: 1800,
        taxableValuePaise: n(input.commissionPaise),
        cgstPaise: 0,
        sgstPaise: 0,
        igstPaise: n(input.commissionTaxPaise),
        totalPaise: n(input.commissionPaise + input.commissionTaxPaise),
      },
    ],
    totals: {
      subtotalPaise: n(input.commissionPaise + input.addOnFeesPaise),
      discountPaise: 0,
      taxableValuePaise: n(input.commissionPaise + input.addOnFeesPaise),
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: n(input.commissionTaxPaise),
      tcsPaise: n(input.tcsPaise),
      grandTotalPaise: n(input.netPayoutPaise),
    },
    footer: `Net payout: ₹${(n(input.netPayoutPaise) / 100).toFixed(2)}. Dispute holds: ₹${(n(input.disputeLiabilitiesPaise) / 100).toFixed(2)}. Adjustments: ₹${(n(input.adjustmentsPaise) / 100).toFixed(2)}.`,
  });
  const up = await uploadObject(buffer, {
    folder: 'closetx/billing-statements',
    resourceType: 'raw',
    contentType: 'application/pdf',
    publicId: `STMT-${input.period}-${input.store.id.slice(-8)}`,
  });
  await db.update(billingStatements).set({ pdfUrl: up.url }).where(eq(billingStatements.id, input.statementId));
}

void invoices;
