import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { customerIssues, heldItems, returns as returnsTable, orderItems } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import {
  addIssueMessage,
  assignAdmin,
  bulkCloseStale,
  changeIssueKind,
  closeIssue,
  createIssue,
  decideIssue,
  escalateIssue,
  flagPartyForAbuse,
  getAdminWorkload,
  getIssueDetail,
  getPartyFlagContext,
  requestEvidence,
} from '@/shared/issues/index.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  AddMessageBody,
  AssignBody,
  BulkCloseBody,
  ChangeKindBody,
  CreateIssueBody,
  DecideBody,
  EscalateBody,
  FlagPartyBody,
  ListIssuesQuery,
  RequestEvidenceBody,
} from './issues.validators.js';

type Auth = AccessTokenPayload;

function shapeIssueRow(r: typeof customerIssues.$inferSelect) {
  const ageMs = Date.now() - r.createdAt.getTime();
  const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  return {
    id: r.id,
    kind: r.kind,
    storeId: r.storeId,
    orderId: r.orderId,
    returnId: r.returnId,
    // Polymorphic target for the UI: an order-linked dispute points at the order,
    // a return-decline dispute (orderId null) points at the return.
    targetKind: (r.orderId ? 'order' : 'return') as 'order' | 'return',
    targetId: r.orderId ?? r.returnId,
    openedByActorType: r.openedByActorType,
    openedByActorId: r.openedByActorId,
    subject: r.subject,
    description: r.description,
    evidence: r.evidence,
    status: r.status,
    awaitingParty: r.awaitingParty,
    assignedAdminId: r.assignedAdminId,
    decision: r.decision,
    decisionNote: r.decisionNote,
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    payoutAdjustmentPaise: r.payoutAdjustmentPaise ? Number(r.payoutAdjustmentPaise) : null,
    linkedHoldId: r.linkedHoldId,
    linkedAdjustmentId: r.linkedAdjustmentId,
    lastMessageAt: r.lastMessageAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    closedAt: r.closedAt ? r.closedAt.toISOString() : null,
    ageDays,
  };
}

export async function listIssues(input: { query: z.infer<typeof ListIssuesQuery> }) {
  const conds = [];
  if (input.query.storeId) conds.push(eq(customerIssues.storeId, input.query.storeId));
  if (input.query.status) conds.push(eq(customerIssues.status, input.query.status));
  if (input.query.awaitingParty)
    conds.push(eq(customerIssues.awaitingParty, input.query.awaitingParty));
  if (input.query.assignedAdminId)
    conds.push(eq(customerIssues.assignedAdminId, input.query.assignedAdminId));
  if (input.query.kind) conds.push(eq(customerIssues.kind, input.query.kind));
  if (input.query.olderThanDays !== undefined) {
    const cutoff = new Date(Date.now() - input.query.olderThanDays * 24 * 60 * 60 * 1000);
    conds.push(lt(customerIssues.createdAt, cutoff));
  }
  const rows = await db.query.customerIssues.findMany({
    where: conds.length > 0 ? and(...conds) : undefined,
    orderBy: desc(customerIssues.lastMessageAt),
    limit: input.query.limit,
  });
  return ok(rows.map(shapeIssueRow));
}

export async function getIssue(input: { id: string }) {
  const d = await getIssueDetail(input.id);
  if (!d) throw new AppError(404, ErrorCode.NotFound, 'Issue not found');
  // Door/store-verification evidence: if issue ties to an order, gather returns rows on its order items;
  // if issue ties to a return directly, fetch that return.
  // Flat list of photos tied to this dispute's return(s), each tagged with who
  // provided it. Empty arrays contribute nothing (so no broken/empty tiles).
  const evidencePhotos: { url: string; source: string; label: string }[] = [];
  const pushReturnPhotos = (
    r: typeof returnsTable.$inferSelect,
    origin: 'return' | 'order-item-return',
  ) => {
    for (const url of r.consumerPhotos ?? []) evidencePhotos.push({ url, source: 'consumer', label: 'Customer' });
    for (const url of r.photos ?? []) evidencePhotos.push({ url, source: 'return', label: 'Return opened' });
    for (const url of r.storeRejectPhotos ?? []) evidencePhotos.push({ url, source: 'store', label: 'Store decline' });
    void origin;
  };
  // Track the return ids tied to this dispute so we can also surface the physical
  // goods (held items) sitting at the store for them.
  const returnIds = new Set<string>();
  if (d.issue.returnId) {
    returnIds.add(d.issue.returnId);
    const r = await db.query.returns.findFirst({ where: eq(returnsTable.id, d.issue.returnId) });
    if (r) pushReturnPhotos(r, 'return');
  }
  if (d.issue.orderId) {
    const items = await db.query.orderItems.findMany({
      where: eq(orderItems.orderId, d.issue.orderId),
      columns: { id: true },
    });
    const itemIds = items.map((i) => i.id);
    if (itemIds.length > 0) {
      const rtns = await db.query.returns.findMany({
        where: (rt, { inArray }) => inArray(rt.orderItemId, itemIds),
      });
      for (const r of rtns) {
        returnIds.add(r.id);
        if (d.issue.returnId && r.id === d.issue.returnId) continue;
        pushReturnPhotos(r, 'order-item-return');
      }
    }
  }
  // Held items = the returned physical goods now sitting at the store for these
  // returns (a declined return shelves the item pending this dispute's outcome).
  const heldRows = returnIds.size
    ? await db.query.heldItems.findMany({
        where: inArray(heldItems.returnId, [...returnIds]),
        columns: {
          id: true,
          status: true,
          disposition: true,
          holdingWindowExpiresAt: true,
          resolvedAt: true,
        },
      })
    : [];
  const held = heldRows.map((h) => ({
    id: h.id,
    status: h.status,
    disposition: h.disposition,
    holdingWindowExpiresAt: h.holdingWindowExpiresAt?.toISOString() ?? null,
    resolvedAt: h.resolvedAt?.toISOString() ?? null,
  }));
  const partyContext = await getPartyFlagContext(d.issue);
  return ok({
    ...shapeIssueRow(d.issue),
    messages: d.messages.map((m) => ({
      id: m.id,
      senderType: m.senderType,
      senderId: m.senderId,
      body: m.body,
      attachments: m.attachments,
      at: m.at.toISOString(),
    })),
    transitions: d.transitions.map((t) => ({
      id: t.id,
      fromStatus: t.fromStatus,
      toStatus: t.toStatus,
      awaitingPartyTo: t.awaitingPartyTo,
      actorType: t.actorType,
      actorId: t.actorId,
      reason: t.reason,
      metadata: t.metadata,
      at: t.at.toISOString(),
    })),
    evidencePhotos,
    heldItems: held,
    partyContext,
  });
}

export async function postIssue(input: { body: z.infer<typeof CreateIssueBody>; auth: Auth }) {
  const r = await createIssue({
    storeId: input.body.storeId,
    kind: input.body.kind,
    orderId: input.body.orderId,
    returnId: input.body.returnId,
    openedByActorType: input.body.openedByActorType,
    openedByActorId: input.body.openedByActorId,
    subject: input.body.subject,
    description: input.body.description,
    evidence: input.body.evidence,
  });
  void input.auth;
  return ok(r);
}

export async function postMessage(input: {
  id: string;
  body: z.infer<typeof AddMessageBody>;
  auth: Auth;
}) {
  const r = await addIssueMessage({
    issueId: input.id,
    senderType: 'admin',
    senderId: input.auth.sub,
    body: input.body.body,
    attachments: input.body.attachments,
  });
  return ok(r);
}

export async function postAssign(input: { id: string; body: z.infer<typeof AssignBody>; auth: Auth }) {
  await assignAdmin({
    issueId: input.id,
    adminId: input.body.adminId,
    awaitingParty: input.body.awaitingParty,
    actorAdminId: input.auth.sub,
  });
  return ok({ id: input.id });
}

export async function postRequestEvidence(input: {
  id: string;
  body: z.infer<typeof RequestEvidenceBody>;
  auth: Auth;
}) {
  await requestEvidence({
    issueId: input.id,
    fromParty: input.body.fromParty,
    note: input.body.note,
    adminId: input.auth.sub,
  });
  return ok({ id: input.id });
}

export async function postDecide(input: { id: string; body: z.infer<typeof DecideBody>; auth: Auth }) {
  const r = await decideIssue({
    issueId: input.id,
    decision: input.body.decision,
    decisionNote: input.body.decisionNote,
    adjustmentPaise: input.body.adjustmentPaise,
    itemDecisions: input.body.itemDecisions,
    adminId: input.auth.sub,
  });
  return ok(r);
}

export async function postEscalate(input: {
  id: string;
  body: z.infer<typeof EscalateBody>;
  auth: Auth;
}) {
  await escalateIssue({ issueId: input.id, note: input.body.note, adminId: input.auth.sub });
  return ok({ id: input.id });
}

export async function postClose(input: { id: string; auth: Auth }) {
  await closeIssue({ issueId: input.id, adminId: input.auth.sub });
  return ok({ id: input.id });
}

export async function postChangeKind(input: {
  id: string;
  body: z.infer<typeof ChangeKindBody>;
  auth: Auth;
}) {
  await changeIssueKind({
    issueId: input.id,
    newKind: input.body.kind,
    adminId: input.auth.sub,
  });
  return ok({ id: input.id, kind: input.body.kind });
}

export async function postFlagParty(input: {
  id: string;
  body: z.infer<typeof FlagPartyBody>;
  auth: Auth;
}) {
  const r = await flagPartyForAbuse({
    issueId: input.id,
    party: input.body.party,
    reason: input.body.reason,
    adminId: input.auth.sub,
  });
  return ok(r);
}

export async function getWorkload() {
  const rows = await getAdminWorkload();
  return ok(rows);
}

/** Sidebar badge source: issues/disputes awaiting an admin decision. */
export async function getCounts() {
  const openStatuses: Array<typeof customerIssues.$inferSelect.status> = [
    'open',
    'requested_evidence',
    'escalated',
  ];
  const rows = await db.query.customerIssues.findMany({
    where: and(
      inArray(customerIssues.status, openStatuses),
      eq(customerIssues.awaitingParty, 'admin'),
    ),
    columns: { kind: true },
  });
  const pendingDisputes = rows.filter((r) => r.kind === 'dispute').length;
  return ok({ pendingDisputes, pendingIssues: rows.length });
}

export async function postBulkClose(input: { body: z.infer<typeof BulkCloseBody>; auth: Auth }) {
  const r = await bulkCloseStale({
    olderThanDays: input.body.olderThanDays,
    noConsumerReplySinceDays: input.body.noConsumerReplySinceDays,
    kind: input.body.kind,
    adminId: input.auth.sub,
  });
  return ok(r);
}
