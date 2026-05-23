import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { adminAccounts, disputes, orders, returns } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  DecideBody,
  EscalateBody,
  ListDisputesQuery,
  OpenDisputeBody,
  RequestEvidenceBody,
} from './disputes.validators.js';

type Auth = AccessTokenPayload;

function withTargetKind(d: typeof disputes.$inferSelect) {
  return {
    ...d,
    targetKind: d.orderId ? 'order' : 'return',
    targetId: d.orderId ?? d.returnId,
  };
}

export async function openDispute(input: { body: z.infer<typeof OpenDisputeBody> }) {
  const { orderId, returnId, openedByActorType, openedByActorId, description, evidence } =
    input.body;

  // Validate target exists
  if (orderId) {
    const order = await db.query.orders.findFirst({ where: eq(orders.id, orderId) });
    if (!order) throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');
  } else {
    const ret = await db.query.returns.findFirst({ where: eq(returns.id, returnId!) });
    if (!ret) throw new AppError(404, ErrorCode.ReturnNotFound, 'Return not found');
  }

  const id = newId(IdPrefix.Dispute);
  const [created] = await db
    .insert(disputes)
    .values({
      id,
      orderId: orderId ?? null,
      returnId: returnId ?? null,
      openedByActorType,
      openedByActorId,
      description,
      evidence,
    })
    .returning();

  return ok(withTargetKind(created!));
}

export async function listDisputes(input: { query: z.infer<typeof ListDisputesQuery> }) {
  const { status, orderId, returnId, limit, offset } = input.query;
  const filters = [];
  if (status) filters.push(eq(disputes.status, status));
  if (orderId) filters.push(eq(disputes.orderId, orderId));
  if (returnId) filters.push(eq(disputes.returnId, returnId));
  const where =
    filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);

  const rows = await db.query.disputes.findMany({
    ...(where && { where }),
    orderBy: desc(disputes.openedAt),
    limit,
    offset,
  });
  return ok(rows.map(withTargetKind));
}

export async function getDispute(id: string) {
  const dispute = await db.query.disputes.findFirst({
    where: eq(disputes.id, id),
  });
  if (!dispute) throw new AppError(404, ErrorCode.DisputeNotFound, 'Dispute not found');

  // Attach a summary of the linked target for context.
  let target: Record<string, unknown> | null = null;
  if (dispute.orderId) {
    const order = await db.query.orders.findFirst({
      where: eq(orders.id, dispute.orderId),
      columns: {
        id: true,
        status: true,
        consumerId: true,
        storeId: true,
        placedAt: true,
        grandTotalPaise: true,
      },
    });
    target = order ?? null;
  } else if (dispute.returnId) {
    const ret = await db.query.returns.findFirst({
      where: eq(returns.id, dispute.returnId),
      columns: {
        id: true,
        kind: true,
        storeDecision: true,
        openedAt: true,
        orderItemId: true,
      },
      with: {
        orderItem: {
          columns: { id: true, listingNameSnap: true, orderId: true },
        },
      },
    });
    target = ret ?? null;
  }

  let decidedByAdmin: { id: string; email: string } | null = null;
  if (dispute.decidedByAdminId) {
    const admin = await db.query.adminAccounts.findFirst({
      where: eq(adminAccounts.id, dispute.decidedByAdminId),
      columns: { id: true, email: true },
    });
    decidedByAdmin = admin ?? null;
  }

  return ok({ ...withTargetKind(dispute), target, decidedByAdmin });
}

export async function requestEvidence(input: {
  id: string;
  body: z.infer<typeof RequestEvidenceBody>;
}) {
  const dispute = await db.query.disputes.findFirst({
    where: eq(disputes.id, input.id),
  });
  if (!dispute) throw new AppError(404, ErrorCode.DisputeNotFound, 'Dispute not found');
  if (dispute.status !== 'open') {
    throw new AppError(
      409,
      ErrorCode.DisputeInvalidState,
      `Cannot request evidence from a dispute in '${dispute.status}' status`,
    );
  }

  const [updated] = await db
    .update(disputes)
    .set({ status: 'requested_evidence', decisionNote: input.body.note })
    .where(eq(disputes.id, dispute.id))
    .returning();

  return ok(withTargetKind(updated!));
}

export async function decideDispute(input: {
  id: string;
  auth: Auth;
  body: z.infer<typeof DecideBody>;
}) {
  const dispute = await db.query.disputes.findFirst({
    where: eq(disputes.id, input.id),
  });
  if (!dispute) throw new AppError(404, ErrorCode.DisputeNotFound, 'Dispute not found');
  if (dispute.status === 'decided') {
    throw new AppError(
      409,
      ErrorCode.DisputeAlreadyDecided,
      'Dispute has already been decided',
    );
  }

  const [updated] = await db
    .update(disputes)
    .set({
      status: 'decided',
      decision: input.body.decision,
      decisionNote: input.body.decisionNote,
      decidedByAdminId: input.auth.sub,
      decidedAt: new Date(),
    })
    .where(eq(disputes.id, dispute.id))
    .returning();

  return ok(withTargetKind(updated!));
}

export async function escalateDispute(input: {
  id: string;
  body: z.infer<typeof EscalateBody>;
}) {
  const dispute = await db.query.disputes.findFirst({
    where: eq(disputes.id, input.id),
  });
  if (!dispute) throw new AppError(404, ErrorCode.DisputeNotFound, 'Dispute not found');
  if (dispute.status === 'decided') {
    throw new AppError(
      409,
      ErrorCode.DisputeAlreadyDecided,
      'Cannot escalate a decided dispute',
    );
  }
  if (dispute.status === 'escalated') {
    throw new AppError(409, ErrorCode.DisputeInvalidState, 'Dispute is already escalated');
  }

  const [updated] = await db
    .update(disputes)
    .set({
      status: 'escalated',
      ...(input.body?.note ? { decisionNote: input.body.note } : {}),
    })
    .where(eq(disputes.id, dispute.id))
    .returning();

  return ok(withTargetKind(updated!));
}
