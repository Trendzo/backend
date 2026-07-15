/**
 * Admin retailer lifecycle: list, approve, reject, suspend, unsuspend, terminate.
 */
import { and, desc, eq, ilike, isNull, lt, or, type SQL } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { retailerAccounts, retailerStores } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { recordAudit } from '@/shared/audit.js';
import { accountTransition, storeTransition } from '@/shared/lifecycle/transitions.js';
import { terminateRetailerCascade } from '@/shared/lifecycle/retailer-cascade.js';
import { notify } from '@/shared/notify.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  ListQuery,
  RejectBody,
  SuspendBody,
  TerminateBody,
  UnsuspendBody,
} from './retailers.validators.js';

type Auth = AccessTokenPayload;

export async function listRetailers(input: { query: z.infer<typeof ListQuery> }) {
  const { status, search, limit, cursor } = input.query;
  const conditions: SQL[] = [];

  if (status === 'pending_approval') {
    conditions.push(eq(retailerAccounts.status, 'pending_approval'));
  } else if (status === 'terminated') {
    conditions.push(eq(retailerAccounts.status, 'terminated'));
  } else if (status === 'closed') {
    conditions.push(eq(retailerAccounts.status, 'closed'));
  } else if (status === 'approved_no_store') {
    conditions.push(eq(retailerAccounts.status, 'active'));
    conditions.push(isNull(retailerAccounts.storeId));
  } else if (
    status === 'onboarding' ||
    status === 'active' ||
    status === 'paused' ||
    status === 'suspended'
  ) {
    conditions.push(eq(retailerAccounts.status, 'active'));
    conditions.push(eq(retailerStores.status, status));
  }

  if (search) {
    conditions.push(
      or(
        ilike(retailerAccounts.legalName, `%${search}%`),
        ilike(retailerAccounts.email, `%${search}%`),
      )!,
    );
  }
  if (cursor) conditions.push(lt(retailerAccounts.createdAt, new Date(cursor)));

  const rows = await db
    .select({
      account: retailerAccounts,
      storeStatus: retailerStores.status,
      storeId: retailerStores.id,
      storeName: retailerStores.legalName,
    })
    .from(retailerAccounts)
    .leftJoin(retailerStores, eq(retailerStores.id, retailerAccounts.storeId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(retailerAccounts.createdAt))
    .limit(limit);

  const safe = rows.map((r) => {
    const { passwordHash: _ph, ...rest } = r.account;
    return { ...rest, storeStatus: r.storeStatus, storeName: r.storeName };
  });
  return ok(safe);
}

export async function approveRetailer(input: { id: string }) {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, input.id),
  });
  if (!retailer) throw new AppError(404, ErrorCode.NotFound, 'Retailer not found');
  if (retailer.status !== 'pending_approval') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `Retailer is in '${retailer.status}', can only approve from 'pending_approval'`,
    );
  }
  const [updated] = await db
    .update(retailerAccounts)
    .set({ status: 'active' })
    .where(eq(retailerAccounts.id, retailer.id))
    .returning();
  const { passwordHash: _ph, ...safe } = updated!;
  return ok(safe);
}

export async function rejectRetailer(input: {
  id: string;
  body: z.infer<typeof RejectBody>;
  log: FastifyBaseLogger;
}) {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, input.id),
  });
  if (!retailer) throw new AppError(404, ErrorCode.NotFound, 'Retailer not found');
  // Central state machine: throws 409 when already terminated, and records WHY —
  // rejected accounts used to carry a bare status with no reason attribution.
  const patch = accountTransition(retailer.status, 'terminate', { reason: input.body.reason });
  const [updated] = await db
    .update(retailerAccounts)
    .set(patch)
    .where(eq(retailerAccounts.id, retailer.id))
    .returning();
  const { passwordHash: _ph, ...safe } = updated!;
  input.log.info({ retailerId: retailer.id, reason: input.body.reason }, 'retailer rejected');
  return ok(safe);
}

export async function suspendRetailer(input: {
  id: string;
  body: z.infer<typeof SuspendBody>;
  log: FastifyBaseLogger;
}) {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, input.id),
  });
  if (!retailer) throw new AppError(404, ErrorCode.NotFound, 'Retailer not found');
  if (retailer.status !== 'active') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `Cannot suspend retailer in '${retailer.status}' status`,
    );
  }
  if (!retailer.storeId) {
    throw new AppError(409, ErrorCode.InvalidState, 'Retailer has no associated store');
  }
  const currentStore = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, retailer.storeId),
  });
  if (!currentStore) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  // Central state machine — also records reason/timestamp, which this path used to drop.
  const patch = storeTransition(currentStore.status, 'suspend', { reason: input.body.reason });
  const [updatedStore] = await db
    .update(retailerStores)
    .set(patch)
    .where(eq(retailerStores.id, retailer.storeId))
    .returning();
  input.log.info({ retailerId: retailer.id, reason: input.body.reason }, 'retailer store suspended');
  const { passwordHash: _ph, ...safe } = retailer;
  return ok({ retailer: safe, store: updatedStore });
}

export async function unsuspendRetailer(input: {
  id: string;
  body: z.infer<typeof UnsuspendBody>;
  log: FastifyBaseLogger;
}) {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, input.id),
  });
  if (!retailer) throw new AppError(404, ErrorCode.NotFound, 'Retailer not found');
  if (!retailer.storeId) {
    throw new AppError(409, ErrorCode.InvalidState, 'Retailer has no associated store');
  }
  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, retailer.storeId),
  });
  if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  const patch = storeTransition(store.status, 'unsuspend');
  const [updatedStore] = await db
    .update(retailerStores)
    .set(patch)
    .where(eq(retailerStores.id, retailer.storeId))
    .returning();
  const body = input.body as { reason?: string } | undefined;
  input.log.info({ retailerId: retailer.id, reason: body?.reason }, 'retailer store unsuspended');
  const { passwordHash: _ph, ...safe } = retailer;
  return ok({ retailer: safe, store: updatedStore });
}

export async function terminateRetailer(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof TerminateBody>;
  requestId: string;
}) {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, input.id),
  });
  if (!retailer) throw new AppError(404, ErrorCode.NotFound, 'Retailer not found');
  // Same implementation as /admin/retailers/:id/ban — the two endpoints used to carry
  // duplicate copies of this transaction, which is how they drifted apart.
  await terminateRetailerCascade(db, retailer.id, {
    reason: input.body.reason,
    actorId: input.auth.sub,
  });
  await recordAudit({
    actor: input.auth,
    action: 'retailer.terminate',
    resourceKind: 'retailer_account',
    resourceId: retailer.id,
    before: { status: retailer.status },
    after: { status: 'terminated' },
    note: input.body.reason,
    requestId: input.requestId,
  });
  await notify({
    recipientKind: 'retailer',
    recipientId: retailer.id,
    kind: 'system',
    title: 'Account terminated',
    body: `Your ClosetX account has been permanently terminated. Reason: ${input.body.reason}`,
    deepLink: null,
  });
  return ok({ retailerId: retailer.id, terminated: true });
}
