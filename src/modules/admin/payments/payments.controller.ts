import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  inventoryReservations,
  payments,
  paymentReconDiscrepancies,
  paymentSettlementEntries,
  paymentSettlements,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { recordAudit } from '@/shared/audit.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { notify } from '@/shared/notify.js';
import { getGateway } from '@/shared/payments/gateway.js';
import { reconcileSettlement } from '@/shared/payments/reconcile.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  ContactConsumerBody,
  ReleaseInventoryBody,
  ResolveDiscrepancyBody,
  SettlementUploadBody,
} from './payments.validators.js';

type Auth = AccessTokenPayload;

// ============== §15 PC2 — Payment capture failures ==============

export async function listPaymentFailures() {
  const rows = await db.query.payments.findMany({
    where: eq(payments.status, 'failed'),
    orderBy: desc(payments.initiatedAt),
    limit: 200,
    with: { order: true },
  });
  return ok(
    rows.map((p) => ({
      id: p.id,
      orderId: p.orderId,
      consumerId: p.order?.consumerId ?? null,
      consumerEmail: p.order?.consumerEmailSnap ?? null,
      consumerPhone: p.order?.consumerPhoneSnap ?? null,
      amountPaise: p.amountPaise,
      method: p.method,
      failureCode: p.failureCode,
      failureMessage: p.failureMessage,
      gatewayRef: p.gatewayRef,
      reservationStillHeld:
        p.order?.status === 'pending' && p.inventoryReleasedAt === null,
      consumerNotifiedAt: p.consumerNotifiedAt?.toISOString() ?? null,
      inventoryReleasedAt: p.inventoryReleasedAt?.toISOString() ?? null,
      failedAt: (p.settledAt ?? p.initiatedAt).toISOString(),
    })),
  );
}

export async function contactConsumer(input: {
  id: string;
  auth: Auth;
  body: z.infer<typeof ContactConsumerBody>;
  requestId: string;
}) {
  const { id, auth, body, requestId } = input;
  const payment = await db.query.payments.findFirst({
    where: eq(payments.id, id),
    with: { order: true },
  });
  if (!payment) throw new AppError(404, ErrorCode.NotFound, 'Payment not found');
  if (payment.status !== 'failed') {
    throw new AppError(409, ErrorCode.InvalidState, 'Payment is not in failed state');
  }
  const now = new Date();
  await db
    .update(payments)
    .set({ consumerNotifiedAt: now, consumerNotifiedByAdminId: auth.sub })
    .where(eq(payments.id, payment.id));
  if (payment.order?.consumerId) {
    await notify({
      recipientKind: 'consumer',
      recipientId: payment.order.consumerId,
      kind: 'order',
      title: 'Payment did not go through',
      body: `Your payment of ₹${(payment.amountPaise / 100).toFixed(2)} for order ${payment.orderId} could not be captured. Please retry from your orders page.`,
      deepLink: `/orders/${payment.orderId}`,
      payload: { paymentId: payment.id, failureCode: payment.failureCode },
    });
  }
  await recordAudit({
    actor: auth,
    action: 'payment.contact_consumer',
    resourceKind: 'payment',
    resourceId: payment.id,
    before: null,
    after: { consumerNotifiedAt: now.toISOString() },
    note: body?.note ?? null,
    requestId,
  });
  return ok({ id: payment.id, consumerNotifiedAt: now.toISOString() });
}

export async function releaseInventory(input: {
  id: string;
  auth: Auth;
  body: z.infer<typeof ReleaseInventoryBody>;
  requestId: string;
}) {
  const { id, auth, body, requestId } = input;
  const payment = await db.query.payments.findFirst({
    where: eq(payments.id, id),
    with: { order: true },
  });
  if (!payment) throw new AppError(404, ErrorCode.NotFound, 'Payment not found');
  if (payment.status !== 'failed') {
    throw new AppError(409, ErrorCode.InvalidState, 'Payment is not in failed state');
  }
  if (payment.inventoryReleasedAt) {
    throw new AppError(409, ErrorCode.InvalidState, 'Inventory already released');
  }
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(inventoryReservations)
      .set({ releasedAt: now, releaseReason: 'cancelled' })
      .where(
        and(
          eq(inventoryReservations.ownerKind, 'order'),
          eq(inventoryReservations.ownerId, payment.orderId),
          isNull(inventoryReservations.releasedAt),
        ),
      );
    await tx
      .update(payments)
      .set({ inventoryReleasedAt: now, inventoryReleasedByAdminId: auth.sub })
      .where(eq(payments.id, payment.id));
  });
  await recordAudit({
    actor: auth,
    action: 'payment.release_inventory',
    resourceKind: 'payment',
    resourceId: payment.id,
    before: null,
    after: { inventoryReleasedAt: now.toISOString() },
    note: body?.reason ?? null,
    requestId,
  });
  return ok({ id: payment.id, inventoryReleasedAt: now.toISOString() });
}

// ============== §15 PC1 — Settlement reconciliation ==============

export async function listReconciliation() {
  const rows = await db.query.paymentSettlements.findMany({
    orderBy: desc(paymentSettlements.cycleEnd),
    limit: 100,
  });
  const openCounts = rows.length
    ? await db
        .select({
          settlementId: paymentReconDiscrepancies.settlementId,
          c: sql<number>`COUNT(*)::int`,
        })
        .from(paymentReconDiscrepancies)
        .where(isNull(paymentReconDiscrepancies.resolvedAt))
        .groupBy(paymentReconDiscrepancies.settlementId)
    : [];
  const openMap = new Map(openCounts.map((r) => [r.settlementId, Number(r.c)]));
  return ok(
    rows.map((s) => ({
      id: s.id,
      gatewayName: s.gatewayName,
      cycleStart: s.cycleStart.toISOString(),
      cycleEnd: s.cycleEnd.toISOString(),
      fileRef: s.fileRef,
      status: s.status,
      summary: s.summary,
      openDiscrepancies: openMap.get(s.id) ?? 0,
      uploadedAt: s.uploadedAt.toISOString(),
      reconciledAt: s.reconciledAt?.toISOString() ?? null,
    })),
  );
}

export async function uploadSettlement(input: {
  auth: Auth;
  body: z.infer<typeof SettlementUploadBody>;
  requestId: string;
}) {
  const { auth, body, requestId } = input;
  const gateway = getGateway(body.gatewayName);
  let entries;
  try {
    entries = gateway.parseSettlement(body.payload);
  } catch (e) {
    throw new AppError(
      400,
      ErrorCode.ValidationError,
      e instanceof Error ? e.message : 'Failed to parse settlement file',
    );
  }
  if (entries.length === 0) {
    throw new AppError(400, ErrorCode.ValidationError, 'Settlement file has no rows');
  }

  const settlementId = newId(IdPrefix.PaymentSettlement);
  await db.transaction(async (tx) => {
    await tx.insert(paymentSettlements).values({
      id: settlementId,
      gatewayName: body.gatewayName,
      cycleStart: body.cycleStart,
      cycleEnd: body.cycleEnd,
      fileRef: body.fileRef ?? null,
      uploadedByAdminId: auth.sub,
    });
    const seen = new Set<string>();
    const rows = entries.flatMap((e) => {
      if (seen.has(e.gatewayRef)) return [];
      seen.add(e.gatewayRef);
      return [
        {
          id: newId(IdPrefix.PaymentSettlementEntry),
          settlementId,
          gatewayRef: e.gatewayRef,
          amountPaise: e.amountPaise,
          currency: e.currency,
          txAt: e.txAt,
          raw: (e.raw ?? null) as Record<string, unknown> | null,
        },
      ];
    });
    if (rows.length > 0) await tx.insert(paymentSettlementEntries).values(rows);
  });

  const summary = await reconcileSettlement(settlementId);
  await recordAudit({
    actor: auth,
    action: 'payment.settlement_uploaded',
    resourceKind: 'payment_settlement',
    resourceId: settlementId,
    before: null,
    after: { gatewayName: body.gatewayName, summary },
    note: body.fileRef ?? null,
    requestId,
  });
  return ok({ id: settlementId, summary });
}

export async function getSettlement(id: string) {
  const settlement = await db.query.paymentSettlements.findFirst({
    where: eq(paymentSettlements.id, id),
  });
  if (!settlement) throw new AppError(404, ErrorCode.NotFound, 'Settlement not found');
  const entries = await db.query.paymentSettlementEntries.findMany({
    where: eq(paymentSettlementEntries.settlementId, settlement.id),
    orderBy: desc(paymentSettlementEntries.txAt),
  });
  const discrepancies = await db.query.paymentReconDiscrepancies.findMany({
    where: eq(paymentReconDiscrepancies.settlementId, settlement.id),
    orderBy: desc(paymentReconDiscrepancies.createdAt),
  });
  return ok({
    settlement: {
      ...settlement,
      cycleStart: settlement.cycleStart.toISOString(),
      cycleEnd: settlement.cycleEnd.toISOString(),
      uploadedAt: settlement.uploadedAt.toISOString(),
      reconciledAt: settlement.reconciledAt?.toISOString() ?? null,
    },
    entries: entries.map((e) => ({ ...e, txAt: e.txAt.toISOString() })),
    discrepancies: discrepancies.map((d) => ({
      ...d,
      createdAt: d.createdAt.toISOString(),
      resolvedAt: d.resolvedAt?.toISOString() ?? null,
    })),
  });
}

export async function rerunSettlement(input: { id: string; auth: Auth; requestId: string }) {
  const { id, auth, requestId } = input;
  const settlement = await db.query.paymentSettlements.findFirst({
    where: eq(paymentSettlements.id, id),
  });
  if (!settlement) throw new AppError(404, ErrorCode.NotFound, 'Settlement not found');
  const summary = await reconcileSettlement(settlement.id);
  await recordAudit({
    actor: auth,
    action: 'payment.settlement_rerun',
    resourceKind: 'payment_settlement',
    resourceId: settlement.id,
    before: null,
    after: { summary },
    note: null,
    requestId,
  });
  return ok({ id: settlement.id, summary });
}

export async function resolveDiscrepancy(input: {
  settlementId: string;
  dId: string;
  auth: Auth;
  body: z.infer<typeof ResolveDiscrepancyBody>;
  requestId: string;
}) {
  const { settlementId, dId, auth, body, requestId } = input;
  const d = await db.query.paymentReconDiscrepancies.findFirst({
    where: and(
      eq(paymentReconDiscrepancies.id, dId),
      eq(paymentReconDiscrepancies.settlementId, settlementId),
    ),
  });
  if (!d) throw new AppError(404, ErrorCode.NotFound, 'Discrepancy not found');
  if (d.resolvedAt) throw new AppError(409, ErrorCode.InvalidState, 'Already resolved');
  const now = new Date();
  await db
    .update(paymentReconDiscrepancies)
    .set({ resolvedAt: now, resolvedByAdminId: auth.sub, resolvedNote: body.note })
    .where(eq(paymentReconDiscrepancies.id, d.id));

  const stillOpen = await db.query.paymentReconDiscrepancies.findFirst({
    where: and(
      eq(paymentReconDiscrepancies.settlementId, d.settlementId),
      isNull(paymentReconDiscrepancies.resolvedAt),
    ),
  });
  if (!stillOpen) {
    await db
      .update(paymentSettlements)
      .set({ status: 'reconciled' })
      .where(eq(paymentSettlements.id, d.settlementId));
  }
  await recordAudit({
    actor: auth,
    action: 'payment.discrepancy_resolved',
    resourceKind: 'payment_recon_discrepancy',
    resourceId: d.id,
    before: { kind: d.kind },
    after: { resolvedAt: now.toISOString() },
    note: body.note,
    requestId,
  });
  return ok({ id: d.id, resolvedAt: now.toISOString() });
}
