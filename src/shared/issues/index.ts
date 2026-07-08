/**
 * §19 — Customer issues shared services. One unified entity (kind=query|complaint|dispute).
 * Behaviour identical across kinds; kind is informational only.
 */
import { and, count, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import {
  consumerFlags,
  customerIssueMessages,
  customerIssueTransitions,
  customerIssues,
  heldItems,
  orders,
  policyEnforcementActions,
  returns as returnsTable,
  orderItems,
} from '@/db/schema/index.js';
import type {
  awaitingParty as awaitingPartyEnum,
  disputeDecision as disputeDecisionEnum,
  issueKind as issueKindEnum,
  supportSenderType as supportSenderTypeEnum,
  actorType as actorTypeEnum,
} from '@/db/schema/enums.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { notifyAllAdmins } from '@/shared/notify-admins.js';
import { notifyStoreAccounts } from '@/shared/notify-store.js';
import { notifyConsumer } from '@/shared/notify-consumer.js';
import { notify } from '@/shared/notify.js';
import { recordAdjustment } from '@/shared/settlement/adjustments.js';
import { autoReleaseHoldsForDispute } from '@/shared/settlement/holds.js';
import { createRefundForReturns } from '@/shared/refunds/create-refund.js';
import { applyAcceptedReturnStockEffect } from '@/shared/returns/restock.js';
import { finalizeReturnedOrder } from '@/shared/orders/finalize-return.js';

type IssueKind = (typeof issueKindEnum.enumValues)[number];
type AwaitingParty = (typeof awaitingPartyEnum.enumValues)[number];
type IssueDecision = (typeof disputeDecisionEnum.enumValues)[number];
type SenderType = (typeof supportSenderTypeEnum.enumValues)[number];
type ActorType = (typeof actorTypeEnum.enumValues)[number];

/* ------------ create -------------- */

export interface CreateIssueInput {
  storeId: string;
  kind: IssueKind;
  orderId?: string | undefined;
  returnId?: string | undefined;
  openedByActorType: ActorType;
  openedByActorId: string;
  subject: string;
  description: string;
  evidence: string[];
}

export async function createIssue(input: CreateIssueInput): Promise<{ issueId: string }> {
  if (!input.orderId && !input.returnId) {
    throw AppError.validation('At least one of orderId or returnId is required');
  }
  // Validate the order/return ties to the claimed store.
  if (input.orderId) {
    const ord = await db.query.orders.findFirst({
      where: eq(orders.id, input.orderId),
      columns: { id: true, storeId: true },
    });
    if (!ord) throw new AppError(404, ErrorCode.NotFound, 'Order not found');
    if (ord.storeId !== input.storeId) {
      throw AppError.validation('Order does not belong to that store');
    }
  }
  if (input.returnId) {
    const rtn = await db.query.returns.findFirst({
      where: eq(returnsTable.id, input.returnId),
      columns: { id: true, orderItemId: true },
    });
    if (!rtn) throw new AppError(404, ErrorCode.NotFound, 'Return not found');
    const oi = await db.query.orderItems.findFirst({
      where: eq(orderItems.id, rtn.orderItemId),
      columns: { orderId: true },
    });
    if (oi) {
      const ord = await db.query.orders.findFirst({
        where: eq(orders.id, oi.orderId),
        columns: { storeId: true },
      });
      if (ord && ord.storeId !== input.storeId) {
        throw AppError.validation('Return does not belong to that store');
      }
    }
  }
  const id = newId(IdPrefix.Issue);
  await db.transaction(async (tx) => {
    await tx.insert(customerIssues).values({
      id,
      kind: input.kind,
      storeId: input.storeId,
      orderId: input.orderId ?? null,
      returnId: input.returnId ?? null,
      openedByActorType: input.openedByActorType,
      openedByActorId: input.openedByActorId,
      subject: input.subject,
      description: input.description,
      evidence: input.evidence,
      status: 'open',
      awaitingParty: 'admin',
    });
    await tx.insert(customerIssueTransitions).values({
      id: newId(IdPrefix.IssueTransition),
      issueId: id,
      fromStatus: null,
      toStatus: 'open',
      awaitingPartyTo: 'admin',
      actorType: input.openedByActorType,
      actorId: input.openedByActorId,
      reason: 'created',
    });
  });
  // Always inform the store that someone (possibly the store themselves) opened a
  // dispute. The query/complaint/dispute kind is no longer surfaced — all are
  // presented as disputes — so the copy is uniform.
  await notifyStoreAccounts({
    storeId: input.storeId,
    kind: 'issue',
    title: `New dispute opened`,
    body: input.subject,
    deepLink: `/disputes/${id}`,
    payload: { issueId: id, kind: input.kind },
  });
  // §22 — alert every admin when a dispute is opened so the queue stays fresh.
  // Every kind now lands in the single Disputes queue, so always fan out.
  await notifyAllAdmins({
    kind: 'issue',
    title: `New dispute opened`,
    body: input.subject,
    deepLink: `/admin/disputes/${id}`,
    payload: { issueId: id, storeId: input.storeId, orderId: input.orderId ?? null },
  });
  return { issueId: id };
}

/* ------------ add message -------------- */

export interface AddMessageInput {
  issueId: string;
  senderType: SenderType;
  senderId: string;
  body: string;
  attachments: string[];
}

export async function addIssueMessage(
  input: AddMessageInput,
): Promise<{ messageId: string }> {
  const issue = await db.query.customerIssues.findFirst({
    where: eq(customerIssues.id, input.issueId),
  });
  if (!issue) throw new AppError(404, ErrorCode.NotFound, 'Dispute not found');
  const id = newId(IdPrefix.IssueMessage);
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(customerIssueMessages).values({
      id,
      issueId: input.issueId,
      senderType: input.senderType,
      senderId: input.senderId,
      body: input.body,
      attachments: input.attachments,
      at: now,
    });
    await tx
      .update(customerIssues)
      .set({ lastMessageAt: now })
      .where(eq(customerIssues.id, input.issueId));
  });
  // Notify the *other* parties. Don't notify the sender's own kind.
  await fanOutMessageNotification(issue, input.senderType, input.body);
  return { messageId: id };
}

async function fanOutMessageNotification(
  issue: typeof customerIssues.$inferSelect,
  senderType: SenderType,
  bodyPreview: string,
): Promise<void> {
  const title = 'New message on dispute';
  const body = bodyPreview.length > 120 ? `${bodyPreview.slice(0, 117)}…` : bodyPreview;
  const deepLink = `/disputes/${issue.id}`;
  const payload = { issueId: issue.id };
  const tasks: Promise<unknown>[] = [];
  if (senderType !== 'retailer') {
    tasks.push(
      notifyStoreAccounts({
        storeId: issue.storeId,
        kind: 'issue',
        title,
        body,
        deepLink,
        payload,
      }),
    );
  }
  if (senderType !== 'consumer' && issue.openedByActorType === 'consumer') {
    tasks.push(
      notifyConsumer({
        consumerId: issue.openedByActorId,
        kind: 'issue',
        title,
        body,
        deepLink,
        payload,
      }),
    );
  }
  if (senderType !== 'admin' && issue.assignedAdminId) {
    tasks.push(
      notify({
        recipientKind: 'admin',
        recipientId: issue.assignedAdminId,
        kind: 'issue',
        title,
        body,
        deepLink,
        payload,
      }),
    );
  }
  await Promise.all(tasks);
}

/* ------------ flip awaiting party -------------- */

export interface SetAwaitingInput {
  issueId: string;
  party: AwaitingParty;
  actorType: ActorType;
  actorId: string;
  reason?: string | undefined;
}

export async function setAwaitingParty(input: SetAwaitingInput): Promise<void> {
  const issue = await db.query.customerIssues.findFirst({
    where: eq(customerIssues.id, input.issueId),
  });
  if (!issue) throw new AppError(404, ErrorCode.NotFound, 'Dispute not found');
  await db.transaction(async (tx) => {
    await tx
      .update(customerIssues)
      .set({ awaitingParty: input.party })
      .where(eq(customerIssues.id, input.issueId));
    await tx.insert(customerIssueTransitions).values({
      id: newId(IdPrefix.IssueTransition),
      issueId: input.issueId,
      fromStatus: issue.status,
      toStatus: issue.status,
      awaitingPartyTo: input.party,
      actorType: input.actorType,
      actorId: input.actorId,
      reason: input.reason ?? 'awaiting_party_change',
    });
  });
  await notifyAwaitee(issue, input.party);
}

async function notifyAwaitee(
  issue: typeof customerIssues.$inferSelect,
  party: AwaitingParty,
): Promise<void> {
  const title = 'Dispute needs your response';
  const body = issue.subject;
  const deepLink = `/disputes/${issue.id}`;
  const payload = { issueId: issue.id };
  if (party === 'retailer') {
    await notifyStoreAccounts({
      storeId: issue.storeId,
      kind: 'issue',
      title,
      body,
      deepLink,
      payload,
    });
  } else if (party === 'consumer' && issue.openedByActorType === 'consumer') {
    await notifyConsumer({
      consumerId: issue.openedByActorId,
      kind: 'issue',
      title,
      body,
      deepLink,
      payload,
    });
  } else if (party === 'admin' && issue.assignedAdminId) {
    await notify({
      recipientKind: 'admin',
      recipientId: issue.assignedAdminId,
      kind: 'issue',
      title,
      body,
      deepLink,
      payload,
    });
  }
}

/* ------------ request evidence -------------- */

export interface RequestEvidenceInput {
  issueId: string;
  fromParty: 'retailer' | 'consumer';
  note: string;
  adminId: string;
}

export async function requestEvidence(input: RequestEvidenceInput): Promise<void> {
  const issue = await db.query.customerIssues.findFirst({
    where: eq(customerIssues.id, input.issueId),
  });
  if (!issue) throw new AppError(404, ErrorCode.NotFound, 'Dispute not found');
  if (issue.status === 'decided') {
    throw new AppError(409, ErrorCode.InvalidState, 'Dispute already decided');
  }
  await db.transaction(async (tx) => {
    await tx
      .update(customerIssues)
      .set({ status: 'requested_evidence', awaitingParty: input.fromParty })
      .where(eq(customerIssues.id, input.issueId));
    await tx.insert(customerIssueTransitions).values({
      id: newId(IdPrefix.IssueTransition),
      issueId: input.issueId,
      fromStatus: issue.status,
      toStatus: 'requested_evidence',
      awaitingPartyTo: input.fromParty,
      actorType: 'admin',
      actorId: input.adminId,
      reason: input.note,
    });
    await tx.insert(customerIssueMessages).values({
      id: newId(IdPrefix.IssueMessage),
      issueId: input.issueId,
      senderType: 'admin',
      senderId: input.adminId,
      body: `Evidence requested: ${input.note}`,
      attachments: [],
    });
  });
  await notifyAwaitee({ ...issue, awaitingParty: input.fromParty }, input.fromParty);
}

/* ------------ assign admin -------------- */

export interface AssignAdminInput {
  issueId: string;
  adminId: string;
  awaitingParty?: AwaitingParty | undefined;
  actorAdminId: string;
}

export async function assignAdmin(input: AssignAdminInput): Promise<void> {
  const issue = await db.query.customerIssues.findFirst({
    where: eq(customerIssues.id, input.issueId),
  });
  if (!issue) throw new AppError(404, ErrorCode.NotFound, 'Dispute not found');
  const nextParty: AwaitingParty = input.awaitingParty ?? issue.awaitingParty;
  await db.transaction(async (tx) => {
    await tx
      .update(customerIssues)
      .set({ assignedAdminId: input.adminId, awaitingParty: nextParty })
      .where(eq(customerIssues.id, input.issueId));
    await tx.insert(customerIssueTransitions).values({
      id: newId(IdPrefix.IssueTransition),
      issueId: input.issueId,
      fromStatus: issue.status,
      toStatus: issue.status,
      awaitingPartyTo: nextParty,
      actorType: 'admin',
      actorId: input.actorAdminId,
      reason: 'assignee_change',
      metadata: { newAdminId: input.adminId },
    });
  });
  await notify({
    recipientKind: 'admin',
    recipientId: input.adminId,
    kind: 'issue',
    title: 'Dispute assigned to you',
    body: issue.subject,
    deepLink: `/disputes/${issue.id}`,
    payload: { issueId: issue.id },
  });
}

/* ------------ escalate -------------- */

export async function escalateIssue(input: {
  issueId: string;
  note: string;
  adminId: string;
}): Promise<void> {
  const issue = await db.query.customerIssues.findFirst({
    where: eq(customerIssues.id, input.issueId),
  });
  if (!issue) throw new AppError(404, ErrorCode.NotFound, 'Dispute not found');
  if (issue.status === 'decided') {
    throw new AppError(409, ErrorCode.InvalidState, 'Dispute already decided');
  }
  await db.transaction(async (tx) => {
    await tx
      .update(customerIssues)
      .set({ status: 'escalated', awaitingParty: 'admin' })
      .where(eq(customerIssues.id, input.issueId));
    await tx.insert(customerIssueTransitions).values({
      id: newId(IdPrefix.IssueTransition),
      issueId: input.issueId,
      fromStatus: issue.status,
      toStatus: 'escalated',
      awaitingPartyTo: 'admin',
      actorType: 'admin',
      actorId: input.adminId,
      reason: input.note,
    });
  });
  // §22 — escalation alerts every admin so super-admins can adopt.
  await notifyAllAdmins({
    kind: 'issue',
    title: 'Dispute escalated to super-admin',
    body: input.note,
    deepLink: `/admin/disputes/${input.issueId}`,
    payload: { issueId: input.issueId, kind: issue.kind, storeId: issue.storeId },
  });
}

/* ------------ close -------------- */

export async function closeIssue(input: { issueId: string; adminId: string }): Promise<void> {
  const issue = await db.query.customerIssues.findFirst({
    where: eq(customerIssues.id, input.issueId),
  });
  if (!issue) throw new AppError(404, ErrorCode.NotFound, 'Dispute not found');
  if (issue.closedAt) {
    throw new AppError(409, ErrorCode.InvalidState, 'Dispute already closed');
  }
  await db.transaction(async (tx) => {
    await tx
      .update(customerIssues)
      .set({ closedAt: new Date(), awaitingParty: 'none' })
      .where(eq(customerIssues.id, input.issueId));
    await tx.insert(customerIssueTransitions).values({
      id: newId(IdPrefix.IssueTransition),
      issueId: input.issueId,
      fromStatus: issue.status,
      toStatus: issue.status,
      awaitingPartyTo: 'none',
      actorType: 'admin',
      actorId: input.adminId,
      reason: 'closed',
    });
  });
}

/* ------------ decide (money-impacting) -------------- */

export interface ItemDecision {
  orderItemId: string;
  decision: IssueDecision;
  adjustmentPaise?: number | undefined;
}

export interface DecideIssueInput {
  issueId: string;
  decision: IssueDecision;
  decisionNote: string;
  adjustmentPaise?: number | undefined;
  /**
   * Optional per-item breakdown. When provided, the aggregate adjustment is the sum of
   * per-item adjustmentPaise; the per-item array is stored in the transition metadata.
   * Issue-level `decision` becomes 'split' automatically if items disagree.
   */
  itemDecisions?: ItemDecision[] | undefined;
  adminId: string;
}

/**
 * Apply the financial outcome of a return dispute. `refundConsumer=true` issues
 * the (previously-withheld) consumer refund and marks the goods restocked;
 * either way the goods are resolved and the order is finalized.
 */
async function settleDisputedReturn(
  returnId: string,
  adminId: string,
  refundConsumer: boolean,
): Promise<void> {
  const ret = await db.query.returns.findFirst({
    where: eq(returnsTable.id, returnId),
    with: { orderItem: { columns: { orderId: true, variantId: true, qty: true } } },
  });
  if (!ret) return;
  const orderId = ret.orderItem.orderId;

  if (refundConsumer) {
    await createRefundForReturns(db, {
      orderId,
      returnIds: [returnId],
      reason: `Dispute resolved — refund for return ${returnId}`,
      actor: { type: 'admin', id: adminId },
    }).catch(() => undefined);
  }
  // Resolve the shelved goods. Guarded flip (only while 'holding') so a prior
  // disposition never double-applies the inventory effect.
  await db.transaction(async (tx) => {
    const [resolved] = await tx
      .update(heldItems)
      .set({
        status: 'resolved',
        disposition: refundConsumer ? 'restocked' : 'forfeited_to_store',
        resolvedAt: new Date(),
      })
      .where(and(eq(heldItems.returnId, returnId), eq(heldItems.status, 'holding')))
      .returning({ id: heldItems.id });
    if (resolved && refundConsumer) {
      // "Restocked" must actually move inventory (standard return → stock+qty;
      // door return → reservation release), same effect as forceDispose.
      await applyAcceptedReturnStockEffect(tx, {
        returnKind: ret.kind,
        variantId: ret.orderItem.variantId,
        qty: ret.orderItem.qty,
      });
    }
  });
  // Drive the order to terminal now that the return is settled.
  await finalizeReturnedOrder(db, orderId, { type: 'admin', id: adminId }).catch(() => undefined);
}

export async function decideIssue(input: DecideIssueInput): Promise<{
  issueId: string;
  decision: IssueDecision;
  adjustmentId: string | null;
  releasedHoldCount: number;
}> {
  const issue = await db.query.customerIssues.findFirst({
    where: eq(customerIssues.id, input.issueId),
  });
  if (!issue) throw new AppError(404, ErrorCode.NotFound, 'Dispute not found');
  if (issue.status === 'decided') {
    throw new AppError(409, ErrorCode.InvalidState, 'Dispute already decided');
  }

  let adjustmentId: string | null = null;
  let releasedHoldCount = 0;
  let appliedAdjustmentPaise: bigint | null = null;
  // null = no return to settle; true = refund consumer; false = forfeit to store.
  // Settled AFTER the issue is committed as 'decided' so the order can finalize.
  let settleRefundConsumer: boolean | null = null;
  // Resolve effective decision + amount: per-item array overrides top-level when present.
  let effectiveDecision = input.decision;
  let effectiveAmount = input.adjustmentPaise ?? 0;
  if (input.itemDecisions && input.itemDecisions.length > 0) {
    const items = input.itemDecisions;
    const decisionsSet = new Set(items.map((i) => i.decision));
    effectiveDecision = decisionsSet.size > 1 ? 'split' : items[0]!.decision;
    effectiveAmount = items.reduce((acc, i) => acc + (i.adjustmentPaise ?? 0), 0);
  }

  // Branch by decision.
  if (effectiveDecision === 'refund' || effectiveDecision === 'split') {
    if (!effectiveAmount || effectiveAmount <= 0) {
      throw AppError.validation(`adjustmentPaise is required for '${effectiveDecision}' decision`);
    }
    const r = await recordAdjustment({
      storeId: issue.storeId,
      direction: 'debit',
      amountPaise: effectiveAmount,
      reason: `issue ${issue.id} decision=${effectiveDecision}: ${input.decisionNote}`,
      adminId: input.adminId,
      kind: 'dispute_liability',
      sourceIssueId: issue.id,
    });
    adjustmentId = r.adjustmentId;
    appliedAdjustmentPaise = BigInt(effectiveAmount);
    releasedHoldCount = await autoReleaseHoldsForDispute(issue.id, input.adminId);
    // Favour-consumer on a return dispute: issue the (withheld) refund + restock.
    // Deferred until after the issue is marked 'decided' below so the order can
    // finalize (returned_to_store → cancelled) — finalizeReturnedOrder refuses to
    // terminalize while it still sees an OPEN dispute on the order/return.
    if (issue.returnId) settleRefundConsumer = true;
  } else if (
    effectiveDecision === 'no_refund' ||
    effectiveDecision === 'fresh_delivery' ||
    effectiveDecision === 'pickup'
  ) {
    releasedHoldCount = await autoReleaseHoldsForDispute(issue.id, input.adminId);
    // Favour-retailer: hold released → retailer paid; no refund. Forfeit + finalize
    // (also deferred until after the 'decided' commit, same reason as above).
    if (issue.returnId) settleRefundConsumer = false;
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(customerIssues)
      .set({
        status: 'decided',
        awaitingParty: 'none',
        decision: effectiveDecision,
        decisionNote: input.decisionNote,
        decidedByAdminId: input.adminId,
        decidedAt: now,
        closedAt: now,
        payoutAdjustmentPaise: appliedAdjustmentPaise,
        linkedAdjustmentId: adjustmentId,
      })
      .where(eq(customerIssues.id, input.issueId));
    await tx.insert(customerIssueTransitions).values({
      id: newId(IdPrefix.IssueTransition),
      issueId: input.issueId,
      fromStatus: issue.status,
      toStatus: 'decided',
      awaitingPartyTo: 'none',
      actorType: 'admin',
      actorId: input.adminId,
      reason: input.decisionNote,
      metadata: {
        decision: effectiveDecision,
        adjustmentPaise: effectiveAmount || null,
        adjustmentId,
        releasedHoldCount,
        itemDecisions: input.itemDecisions ?? null,
      },
    });
  });

  // Now that the dispute is committed as 'decided', settle the return: issue the
  // refund (or forfeit), resolve the shelved goods, and finalize the order to a
  // terminal state. Deferred to here so finalizeReturnedOrder no longer sees this
  // dispute as open and can take returned_to_store → cancelled.
  if (issue.returnId && settleRefundConsumer !== null) {
    await settleDisputedReturn(issue.returnId, input.adminId, settleRefundConsumer);
  }

  // Notify retailer (issue resolution + payout if money moved).
  const title = `Dispute decided: ${effectiveDecision}`;
  const body = input.decisionNote;
  const deepLink = `/disputes/${issue.id}`;
  await notifyStoreAccounts({
    storeId: issue.storeId,
    kind: 'issue',
    title,
    body,
    deepLink,
    payload: { issueId: issue.id, decision: effectiveDecision },
  });
  if (appliedAdjustmentPaise && appliedAdjustmentPaise > 0n) {
    await notifyStoreAccounts({
      storeId: issue.storeId,
      kind: 'payout',
      title: 'Payout adjustment recorded',
      body: `Dispute ${issue.id} debited ${appliedAdjustmentPaise} paise on next payout cycle.`,
      deepLink,
      payload: {
        issueId: issue.id,
        adjustmentId,
        adjustmentPaise: Number(appliedAdjustmentPaise),
      },
    });
  }
  // Notify consumer-opener (if applicable).
  if (issue.openedByActorType === 'consumer') {
    await notifyConsumer({
      consumerId: issue.openedByActorId,
      kind: 'issue',
      title,
      body,
      deepLink,
      payload: { issueId: issue.id, decision: effectiveDecision },
    });
  }

  return {
    issueId: issue.id,
    decision: effectiveDecision,
    adjustmentId,
    releasedHoldCount,
  };
}

/* ------------ read helpers -------------- */

export async function getIssueDetail(issueId: string) {
  const issue = await db.query.customerIssues.findFirst({
    where: eq(customerIssues.id, issueId),
    with: {
      order: true,
      return: true,
      assignedAdmin: { columns: { id: true, email: true, subRole: true } },
      decidedByAdmin: { columns: { id: true, email: true } },
    },
  });
  if (!issue) return null;
  const messages = await db.query.customerIssueMessages.findMany({
    where: eq(customerIssueMessages.issueId, issueId),
    orderBy: (m, { asc }) => [asc(m.at)],
  });
  const transitions = await db.query.customerIssueTransitions.findMany({
    where: eq(customerIssueTransitions.issueId, issueId),
    orderBy: (t, { asc }) => [asc(t.at)],
  });
  return { issue, messages, transitions };
}

export function isIssueVisibleToConsumer(
  issue: typeof customerIssues.$inferSelect,
  consumerId: string,
): boolean {
  return issue.openedByActorType === 'consumer' && issue.openedByActorId === consumerId;
}

export async function isOrderOwnedByConsumer(orderId: string, consumerId: string): Promise<boolean> {
  const ord = await db.query.orders.findFirst({
    where: and(eq(orders.id, orderId), eq(orders.consumerId, consumerId)),
    columns: { id: true },
  });
  return !!ord;
}

/* ------------ change kind (promote/demote) -------------- */

export async function changeIssueKind(input: {
  issueId: string;
  newKind: IssueKind;
  adminId: string;
}): Promise<void> {
  const issue = await db.query.customerIssues.findFirst({
    where: eq(customerIssues.id, input.issueId),
  });
  if (!issue) throw new AppError(404, ErrorCode.NotFound, 'Dispute not found');
  if (issue.status === 'decided') {
    throw new AppError(409, ErrorCode.InvalidState, 'Cannot change kind of a decided issue');
  }
  if (issue.linkedAdjustmentId || issue.linkedHoldId) {
    throw new AppError(409, ErrorCode.InvalidState, 'Cannot change kind once money has moved');
  }
  if (issue.kind === input.newKind) return;
  await db.transaction(async (tx) => {
    await tx
      .update(customerIssues)
      .set({ kind: input.newKind })
      .where(eq(customerIssues.id, input.issueId));
    await tx.insert(customerIssueTransitions).values({
      id: newId(IdPrefix.IssueTransition),
      issueId: input.issueId,
      fromStatus: issue.status,
      toStatus: issue.status,
      awaitingPartyTo: issue.awaitingParty,
      actorType: 'admin',
      actorId: input.adminId,
      reason: `kind_change:${issue.kind}->${input.newKind}`,
      metadata: { fromKind: issue.kind, toKind: input.newKind },
    });
  });
}

/* ------------ flag party for repeat abuse -------------- */

export async function flagPartyForAbuse(input: {
  issueId: string;
  party: 'consumer' | 'retailer';
  reason: string;
  adminId: string;
}): Promise<{ flagId: string; flagTable: 'consumer_flags' | 'policy_enforcement_actions' }> {
  const issue = await db.query.customerIssues.findFirst({
    where: eq(customerIssues.id, input.issueId),
  });
  if (!issue) throw new AppError(404, ErrorCode.NotFound, 'Dispute not found');

  if (input.party === 'consumer') {
    if (issue.openedByActorType !== 'consumer') {
      // Fall back to the order's consumer if available.
      let consumerId: string | null = null;
      if (issue.orderId) {
        const ord = await db.query.orders.findFirst({
          where: eq(orders.id, issue.orderId),
          columns: { consumerId: true },
        });
        consumerId = ord?.consumerId ?? null;
      }
      if (!consumerId) {
        throw new AppError(409, ErrorCode.InvalidState, 'No consumer to flag on this issue');
      }
      const id = newId('cfg');
      await db.insert(consumerFlags).values({
        id,
        consumerId,
        kind: 'dispute_pattern',
        reason: input.reason,
        createdByAdminId: input.adminId,
      });
      await db.insert(customerIssueTransitions).values({
        id: newId(IdPrefix.IssueTransition),
        issueId: input.issueId,
        fromStatus: issue.status,
        toStatus: issue.status,
        awaitingPartyTo: issue.awaitingParty,
        actorType: 'admin',
        actorId: input.adminId,
        reason: 'flag_consumer_for_abuse',
        metadata: { consumerId, flagId: id, reason: input.reason },
      });
      return { flagId: id, flagTable: 'consumer_flags' };
    }
    const id = newId('cfg');
    await db.insert(consumerFlags).values({
      id,
      consumerId: issue.openedByActorId,
      kind: 'dispute_pattern',
      reason: input.reason,
      createdByAdminId: input.adminId,
    });
    await db.insert(customerIssueTransitions).values({
      id: newId(IdPrefix.IssueTransition),
      issueId: input.issueId,
      fromStatus: issue.status,
      toStatus: issue.status,
      awaitingPartyTo: issue.awaitingParty,
      actorType: 'admin',
      actorId: input.adminId,
      reason: 'flag_consumer_for_abuse',
      metadata: { consumerId: issue.openedByActorId, flagId: id, reason: input.reason },
    });
    return { flagId: id, flagTable: 'consumer_flags' };
  }

  // retailer abuse — record onto policy_enforcement_actions as a warning step.
  const id = newId('enf');
  await db.insert(policyEnforcementActions).values({
    id,
    storeId: issue.storeId,
    step: 'warning_1',
    breachKind: 'policy_violation',
    metric: { source: 'issue', issueId: issue.id },
    actedByAccountId: input.adminId,
    reason: input.reason,
  });
  await db.insert(customerIssueTransitions).values({
    id: newId(IdPrefix.IssueTransition),
    issueId: input.issueId,
    fromStatus: issue.status,
    toStatus: issue.status,
    awaitingPartyTo: issue.awaitingParty,
    actorType: 'admin',
    actorId: input.adminId,
    reason: 'flag_retailer_for_abuse',
    metadata: { storeId: issue.storeId, enforcementId: id, reason: input.reason },
  });
  return { flagId: id, flagTable: 'policy_enforcement_actions' };
}

/* ------------ list parties' open flags (detail enrichment) -------------- */

export async function getPartyFlagContext(issue: typeof customerIssues.$inferSelect) {
  const out: {
    consumerFlags: Array<{ id: string; kind: string; reason: string; createdAt: string }>;
    retailerEnforcement: Array<{ id: string; step: string; breachKind: string; reason: string | null; actedAt: string }>;
  } = { consumerFlags: [], retailerEnforcement: [] };

  // consumer flags: look up consumer behind issue
  let consumerId: string | null = null;
  if (issue.openedByActorType === 'consumer') consumerId = issue.openedByActorId;
  if (!consumerId && issue.orderId) {
    const ord = await db.query.orders.findFirst({
      where: eq(orders.id, issue.orderId),
      columns: { consumerId: true },
    });
    consumerId = ord?.consumerId ?? null;
  }
  if (consumerId) {
    const flags = await db.query.consumerFlags.findMany({
      where: and(eq(consumerFlags.consumerId, consumerId), isNull(consumerFlags.resolvedAt)),
    });
    out.consumerFlags = flags.map((f) => ({
      id: f.id,
      kind: f.kind,
      reason: f.reason,
      createdAt: f.createdAt.toISOString(),
    }));
  }
  // retailer enforcement steps for the store (non-lifted).
  const enf = await db
    .select()
    .from(policyEnforcementActions)
    .where(eq(policyEnforcementActions.storeId, issue.storeId));
  out.retailerEnforcement = enf
    .filter((e) => e.step !== 'lifted')
    .map((e) => ({
      id: e.id,
      step: e.step,
      breachKind: e.breachKind,
      reason: e.reason,
      actedAt: e.actedAt.toISOString(),
    }));
  return out;
}

/* ------------ workload per agent -------------- */

export async function getAdminWorkload(): Promise<
  Array<{ assignedAdminId: string | null; openCount: number }>
> {
  const rows = await db
    .select({
      assignedAdminId: customerIssues.assignedAdminId,
      openCount: count(customerIssues.id),
    })
    .from(customerIssues)
    .where(or(eq(customerIssues.status, 'open'), eq(customerIssues.status, 'requested_evidence'))!)
    .groupBy(customerIssues.assignedAdminId);
  return rows.map((r) => ({
    assignedAdminId: r.assignedAdminId,
    openCount: Number(r.openCount),
  }));
}

/* ------------ bulk-close stale issues -------------- */

export async function bulkCloseStale(input: {
  olderThanDays: number;
  noConsumerReplySinceDays?: number | undefined;
  kind?: IssueKind | undefined;
  adminId: string;
}): Promise<{ closedCount: number; closedIds: string[] }> {
  const ageCutoff = new Date(Date.now() - input.olderThanDays * 24 * 60 * 60 * 1000);
  const conds = [
    or(
      eq(customerIssues.status, 'open'),
      eq(customerIssues.status, 'requested_evidence'),
    )!,
    isNull(customerIssues.closedAt),
    lt(customerIssues.createdAt, ageCutoff),
  ];
  if (input.kind) conds.push(eq(customerIssues.kind, input.kind));
  const candidates = await db.query.customerIssues.findMany({
    where: and(...conds),
    columns: { id: true, lastMessageAt: true },
  });
  let toClose = candidates;
  if (input.noConsumerReplySinceDays !== undefined) {
    const replyCutoff = new Date(
      Date.now() - input.noConsumerReplySinceDays * 24 * 60 * 60 * 1000,
    );
    const candidateIds = candidates.map((c) => c.id);
    const consumerMsgs =
      candidateIds.length === 0
        ? []
        : await db.query.customerIssueMessages.findMany({
            where: and(
              inArray(customerIssueMessages.issueId, candidateIds),
              eq(customerIssueMessages.senderType, 'consumer'),
            ),
            columns: { issueId: true, at: true },
          });
    const lastConsumerByIssue = new Map<string, Date>();
    for (const m of consumerMsgs) {
      const prev = lastConsumerByIssue.get(m.issueId);
      if (!prev || m.at > prev) lastConsumerByIssue.set(m.issueId, m.at);
    }
    toClose = candidates.filter((c) => {
      const last = lastConsumerByIssue.get(c.id);
      // No consumer reply ever → eligible. Otherwise need last reply older than cutoff.
      return !last || last < replyCutoff;
    });
  }
  const closedIds: string[] = [];
  const now = new Date();
  for (const c of toClose) {
    await db.transaction(async (tx) => {
      await tx
        .update(customerIssues)
        .set({ closedAt: now, awaitingParty: 'none' })
        .where(eq(customerIssues.id, c.id));
      await tx.insert(customerIssueTransitions).values({
        id: newId(IdPrefix.IssueTransition),
        issueId: c.id,
        fromStatus: null,
        toStatus: 'open',
        awaitingPartyTo: 'none',
        actorType: 'admin',
        actorId: input.adminId,
        reason: `bulk_close_stale:olderThanDays=${input.olderThanDays}`,
      });
    });
    closedIds.push(c.id);
  }
  void sql;
  return { closedCount: closedIds.length, closedIds };
}
