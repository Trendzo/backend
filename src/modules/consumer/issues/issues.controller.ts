import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  customerIssues,
  orders,
  orderItems,
  returns as returnsTable,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import {
  addIssueMessage,
  createIssue,
  getIssueDetail,
  isIssueVisibleToConsumer,
  isOrderOwnedByConsumer,
} from '@/shared/issues/index.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  AddMessageBody,
  CreateIssueBody,
  ListIssuesQuery,
} from './issues.validators.js';

type Auth = AccessTokenPayload;

function shapeIssueRow(r: typeof customerIssues.$inferSelect) {
  return {
    id: r.id,
    kind: r.kind,
    storeId: r.storeId,
    orderId: r.orderId,
    returnId: r.returnId,
    subject: r.subject,
    description: r.description,
    evidence: r.evidence,
    status: r.status,
    awaitingParty: r.awaitingParty,
    decision: r.decision,
    decisionNote: r.decisionNote,
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    lastMessageAt: r.lastMessageAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    closedAt: r.closedAt ? r.closedAt.toISOString() : null,
  };
}

async function resolveOrderForReturn(returnId: string): Promise<string | null> {
  const rtn = await db.query.returns.findFirst({
    where: eq(returnsTable.id, returnId),
    columns: { orderItemId: true },
  });
  if (!rtn) return null;
  const oi = await db.query.orderItems.findFirst({
    where: eq(orderItems.id, rtn.orderItemId),
    columns: { orderId: true },
  });
  return oi?.orderId ?? null;
}

async function storeIdForOrder(orderId: string): Promise<string | null> {
  const o = await db.query.orders.findFirst({
    where: eq(orders.id, orderId),
    columns: { storeId: true },
  });
  return o?.storeId ?? null;
}

export async function listIssues(input: { auth: Auth; query: z.infer<typeof ListIssuesQuery> }) {
  const conds = [
    eq(customerIssues.openedByActorType, 'consumer'),
    eq(customerIssues.openedByActorId, input.auth.sub),
  ];
  if (input.query.status) conds.push(eq(customerIssues.status, input.query.status));
  if (input.query.kind) conds.push(eq(customerIssues.kind, input.query.kind));
  const rows = await db.query.customerIssues.findMany({
    where: and(...conds),
    orderBy: desc(customerIssues.lastMessageAt),
    limit: input.query.limit,
  });
  return ok(rows.map(shapeIssueRow));
}

export async function getIssue(input: { auth: Auth; id: string }) {
  const d = await getIssueDetail(input.id);
  if (!d || !isIssueVisibleToConsumer(d.issue, input.auth.sub)) {
    throw new AppError(404, ErrorCode.NotFound, 'Issue not found');
  }
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
  });
}

export async function postIssue(input: { auth: Auth; body: z.infer<typeof CreateIssueBody> }) {
  // Resolve storeId from order/return and assert ownership.
  let storeId: string | null = null;
  if (input.body.orderId) {
    const owned = await isOrderOwnedByConsumer(input.body.orderId, input.auth.sub);
    if (!owned) throw new AppError(404, ErrorCode.NotFound, 'Order not found');
    storeId = await storeIdForOrder(input.body.orderId);
  } else if (input.body.returnId) {
    const orderId = await resolveOrderForReturn(input.body.returnId);
    if (!orderId) throw new AppError(404, ErrorCode.NotFound, 'Return not found');
    const owned = await isOrderOwnedByConsumer(orderId, input.auth.sub);
    if (!owned) throw new AppError(404, ErrorCode.NotFound, 'Return not found');
    storeId = await storeIdForOrder(orderId);
  }
  if (!storeId) {
    throw new AppError(404, ErrorCode.NotFound, 'Cannot resolve store for issue');
  }
  const r = await createIssue({
    storeId,
    kind: input.body.kind,
    orderId: input.body.orderId,
    returnId: input.body.returnId,
    openedByActorType: 'consumer',
    openedByActorId: input.auth.sub,
    subject: input.body.subject,
    description: input.body.description,
    evidence: input.body.evidence,
  });
  return ok(r);
}

export async function postMessage(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof AddMessageBody>;
}) {
  const issue = await db.query.customerIssues.findFirst({
    where: eq(customerIssues.id, input.id),
  });
  if (!issue || !isIssueVisibleToConsumer(issue, input.auth.sub)) {
    throw new AppError(404, ErrorCode.NotFound, 'Issue not found');
  }
  const r = await addIssueMessage({
    issueId: input.id,
    senderType: 'consumer',
    senderId: input.auth.sub,
    body: input.body.body,
    attachments: input.body.attachments,
  });
  return ok(r);
}
