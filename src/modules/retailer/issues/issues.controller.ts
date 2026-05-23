import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { customerIssues, retailerAccounts } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import {
  addIssueMessage,
  createIssue,
  getIssueDetail,
  setAwaitingParty,
} from '@/shared/issues/index.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  AddMessageBody,
  CreateIssueBody,
  ListIssuesQuery,
} from './issues.validators.js';

type Auth = AccessTokenPayload;

async function resolveStoreId(auth: Auth): Promise<string> {
  const r = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, auth.sub),
  });
  if (!r?.storeId) {
    throw new AppError(403, ErrorCode.StoreNotActive, 'No active store on this account');
  }
  return r.storeId;
}

function shapeIssueRow(r: typeof customerIssues.$inferSelect) {
  return {
    id: r.id,
    kind: r.kind,
    storeId: r.storeId,
    orderId: r.orderId,
    returnId: r.returnId,
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
  };
}

export async function listIssues(input: { auth: Auth; query: z.infer<typeof ListIssuesQuery> }) {
  const storeId = await resolveStoreId(input.auth);
  const conds = [eq(customerIssues.storeId, storeId)];
  if (input.query.status) conds.push(eq(customerIssues.status, input.query.status));
  if (input.query.awaitingParty)
    conds.push(eq(customerIssues.awaitingParty, input.query.awaitingParty));
  if (input.query.kind) conds.push(eq(customerIssues.kind, input.query.kind));
  if (input.query.orderId) conds.push(eq(customerIssues.orderId, input.query.orderId));
  const rows = await db.query.customerIssues.findMany({
    where: and(...conds),
    orderBy: desc(customerIssues.lastMessageAt),
    limit: input.query.limit,
  });
  return ok(rows.map(shapeIssueRow));
}

export async function getIssue(input: { auth: Auth; id: string }) {
  const storeId = await resolveStoreId(input.auth);
  const d = await getIssueDetail(input.id);
  if (!d || d.issue.storeId !== storeId) {
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
  const storeId = await resolveStoreId(input.auth);
  const r = await createIssue({
    storeId,
    kind: input.body.kind,
    orderId: input.body.orderId,
    returnId: input.body.returnId,
    openedByActorType: 'retailer',
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
  const storeId = await resolveStoreId(input.auth);
  const issue = await db.query.customerIssues.findFirst({
    where: eq(customerIssues.id, input.id),
  });
  if (!issue || issue.storeId !== storeId) {
    throw new AppError(404, ErrorCode.NotFound, 'Issue not found');
  }
  const r = await addIssueMessage({
    issueId: input.id,
    senderType: 'retailer',
    senderId: input.auth.sub,
    body: input.body.body,
    attachments: input.body.attachments,
  });
  return ok(r);
}

export async function postHandBack(input: { auth: Auth; id: string }) {
  const storeId = await resolveStoreId(input.auth);
  const issue = await db.query.customerIssues.findFirst({
    where: eq(customerIssues.id, input.id),
  });
  if (!issue || issue.storeId !== storeId) {
    throw new AppError(404, ErrorCode.NotFound, 'Issue not found');
  }
  if (issue.awaitingParty !== 'retailer') {
    throw new AppError(409, ErrorCode.InvalidState, 'Issue is not awaiting retailer');
  }
  await setAwaitingParty({
    issueId: input.id,
    party: 'admin',
    actorType: 'retailer',
    actorId: input.auth.sub,
    reason: 'retailer_hand_back',
  });
  return ok({ id: input.id });
}
