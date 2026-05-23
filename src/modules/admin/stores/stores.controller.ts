/**
 * Admin store lifecycle: list, approve, reject.
 */
import { and, desc, eq, ilike, lt, sql, type SQL } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { retailerAccounts, retailerStores } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import type { ApproveBody, ListQuery, RejectBody } from './stores.validators.js';

export async function listStores(input: { query: z.infer<typeof ListQuery> }) {
  const { status, search, stateCode, limit, cursor } = input.query;
  const conditions: SQL[] = [];
  if (status) conditions.push(eq(retailerStores.status, status));
  if (search) conditions.push(ilike(retailerStores.legalName, `%${search}%`));
  if (stateCode) conditions.push(eq(retailerStores.stateCode, stateCode));
  if (cursor) conditions.push(lt(retailerStores.createdAt, new Date(cursor)));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await db
    .select({
      id: retailerStores.id,
      legalEntityId: retailerStores.legalEntityId,
      legalName: retailerStores.legalName,
      gstin: retailerStores.gstin,
      address: retailerStores.address,
      stateCode: retailerStores.stateCode,
      lat: retailerStores.lat,
      lng: retailerStores.lng,
      status: retailerStores.status,
      permanentSuspend: retailerStores.permanentSuspend,
      suspendReason: retailerStores.suspendReason,
      pauseReason: retailerStores.pauseReason,
      pauseVisibility: retailerStores.pauseVisibility,
      pauseUntil: retailerStores.pauseUntil,
      contactPhone: retailerStores.contactPhone,
      managerName: retailerStores.managerName,
      platformFeeBp: retailerStores.platformFeeBp,
      payoutCadenceDays: retailerStores.payoutCadenceDays,
      createdAt: retailerStores.createdAt,
      retailerId: retailerAccounts.id,
      retailerEmail: retailerAccounts.email,
      retailerLegalName: retailerAccounts.legalName,
      retailerStatus: retailerAccounts.status,
      orderCount: sql<number>`(SELECT COUNT(*)::int FROM orders WHERE store_id = ${retailerStores.id})`,
      disputeCount: sql<number>`(SELECT COUNT(*)::int FROM disputes WHERE order_id IN (SELECT id FROM orders WHERE store_id = ${retailerStores.id}))`,
    })
    .from(retailerStores)
    .leftJoin(
      retailerAccounts,
      and(eq(retailerAccounts.storeId, retailerStores.id), eq(retailerAccounts.subRole, 'owner')),
    )
    .where(where)
    .orderBy(desc(retailerStores.createdAt))
    .limit(limit);
  const view = rows.map(({ retailerId, retailerEmail, retailerLegalName, retailerStatus, ...store }) => ({
    ...store,
    retailer: retailerId
      ? { id: retailerId, email: retailerEmail, legalName: retailerLegalName, status: retailerStatus }
      : null,
  }));
  return ok(view);
}

export async function approveStore(input: { id: string; body: z.infer<typeof ApproveBody> }) {
  const body = input.body as { platformFeeBp?: number; payoutCadenceDays?: number };
  const platformFeeBp = body.platformFeeBp ?? 1500;
  const payoutCadenceDays = body.payoutCadenceDays ?? 7;
  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, input.id),
  });
  if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  if (store.status !== 'onboarding') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `Store is in '${store.status}', can only approve from 'onboarding'`,
    );
  }

  const owner = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.storeId, store.id),
  });
  if (!owner) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'Storefront has no owning retailer on file — investigate.',
    );
  }
  if (owner.status !== 'active') {
    throw new AppError(
      409,
      ErrorCode.RetailerNotApproved,
      `Approve the retailer (${owner.email}) before approving its storefront — currently '${owner.status}'.`,
    );
  }

  const [updated] = await db
    .update(retailerStores)
    .set({ status: 'active', platformFeeBp, payoutCadenceDays })
    .where(eq(retailerStores.id, store.id))
    .returning();
  return ok(updated);
}

export async function rejectStore(input: {
  id: string;
  body: z.infer<typeof RejectBody>;
  log: FastifyBaseLogger;
}) {
  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, input.id),
  });
  if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  if (store.status === 'terminated') {
    throw new AppError(409, ErrorCode.InvalidState, 'Store is already terminated');
  }
  const [updated] = await db
    .update(retailerStores)
    .set({ status: 'terminated' })
    .where(eq(retailerStores.id, store.id))
    .returning();
  input.log.info({ storeId: store.id, reason: input.body.reason }, 'store rejected');
  return ok(updated);
}
