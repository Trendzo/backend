/**
 * Admin store-management: direct create, edit, pause, resume, suspend, ban, unsuspend, unban.
 */
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { retailerAccounts, retailerStores } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { recordAudit } from '@/shared/audit.js';
import { notify } from '@/shared/notify.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  OptionalReasonBody,
  PauseBody,
  ReasonBody,
  StoreCreateBody,
  StoreEditBody,
} from './store-mgmt.validators.js';

type Auth = AccessTokenPayload;

async function loadRetailerOr404(retailerId: string) {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
  });
  if (!retailer) throw new AppError(404, ErrorCode.NotFound, 'Retailer not found');
  return retailer;
}

async function loadStoreOr404(storeId: string) {
  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, storeId),
  });
  if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  return store;
}

async function notifyOwners(
  storeId: string,
  payload: { title: string; body?: string; deepLink?: string; data?: Record<string, unknown> },
): Promise<void> {
  const owners = await db.query.retailerAccounts.findMany({
    where: eq(retailerAccounts.storeId, storeId),
  });
  await Promise.all(
    owners.map((o) =>
      notify({
        recipientKind: 'retailer',
        recipientId: o.id,
        kind: 'system',
        title: payload.title,
        body: payload.body ?? null,
        deepLink: payload.deepLink ?? null,
        payload: payload.data ?? null,
      }),
    ),
  );
}

export async function directCreateStore(input: {
  auth: Auth;
  body: z.infer<typeof StoreCreateBody>;
  requestId: string;
}) {
  const owner = await loadRetailerOr404(input.body.legalEntityId);
  if (owner.status !== 'active') {
    throw new AppError(409, ErrorCode.InvalidState, `Retailer is not active ('${owner.status}')`);
  }
  const storeId = newId(IdPrefix.Store);
  await db.insert(retailerStores).values({
    id: storeId,
    legalEntityId: owner.id,
    legalName: input.body.storeName,
    gstin: input.body.gstin,
    pan: input.body.pan ?? null,
    address: input.body.address,
    stateCode: input.body.stateCode,
    lat: input.body.lat,
    lng: input.body.lng,
    openingHours: input.body.openingHours ?? null,
    status: 'active',
    platformFeeBp: input.body.platformFeeBp,
    payoutCadenceDays: input.body.payoutCadenceDays,
  });
  await recordAudit({
    actor: input.auth,
    action: 'store.create',
    resourceKind: 'retailer_store',
    resourceId: storeId,
    after: { storeName: input.body.storeName, legalEntityId: owner.id },
    requestId: input.requestId,
  });
  await notify({
    recipientKind: 'retailer',
    recipientId: owner.id,
    kind: 'system',
    title: 'New store added by admin',
    body: `Admin added a new store "${input.body.storeName}" to your account.`,
    deepLink: '/retailer/store',
  });
  return ok({ id: storeId, status: 'active' });
}

export async function getStore(input: { id: string }) {
  const store = await loadStoreOr404(input.id);
  const owner = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.storeId, store.id),
    columns: { id: true, email: true, legalName: true, status: true },
  });
  return ok({ ...store, retailer: owner ?? null });
}

export async function editStore(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof StoreEditBody>;
  requestId: string;
}) {
  const store = await loadStoreOr404(input.id);
  const body = input.body as {
    storeName?: string;
    gstin?: string;
    address?: string;
    stateCode?: string;
    lat?: number;
    lng?: number;
    openingHours?: Record<string, Array<{ open: string; close: string }>>;
    contactPhone?: string | null;
    managerName?: string | null;
    platformFeeBp?: number;
    payoutCadenceDays?: number;
    platformFeeReason?: string;
  };
  const patch: Record<string, unknown> = {};
  if (body.storeName !== undefined) patch.legalName = body.storeName;
  if (body.gstin !== undefined) patch.gstin = body.gstin;
  if (body.address !== undefined) patch.address = body.address;
  if (body.stateCode !== undefined) patch.stateCode = body.stateCode;
  if (body.lat !== undefined) patch.lat = body.lat;
  if (body.lng !== undefined) patch.lng = body.lng;
  if (body.openingHours !== undefined) patch.openingHours = body.openingHours ?? null;
  if (body.contactPhone !== undefined) patch.contactPhone = body.contactPhone ?? null;
  if (body.managerName !== undefined) patch.managerName = body.managerName ?? null;
  if (body.platformFeeBp !== undefined) patch.platformFeeBp = body.platformFeeBp;
  if (body.payoutCadenceDays !== undefined) patch.payoutCadenceDays = body.payoutCadenceDays;
  const [updated] = await db
    .update(retailerStores)
    .set(patch)
    .where(eq(retailerStores.id, store.id))
    .returning();
  const feeChanged = body.platformFeeBp !== undefined && body.platformFeeBp !== store.platformFeeBp;
  await recordAudit({
    actor: input.auth,
    action: feeChanged ? 'store.platform_fee_override' : 'store.update',
    resourceKind: 'retailer_store',
    resourceId: store.id,
    before: {
      legalName: store.legalName,
      gstin: store.gstin,
      address: store.address,
      platformFeeBp: store.platformFeeBp,
      payoutCadenceDays: store.payoutCadenceDays,
    },
    after: patch,
    impersonatedStoreId: store.id,
    note: feeChanged ? body.platformFeeReason ?? null : null,
    requestId: input.requestId,
  });
  await notifyOwners(store.id, {
    title: 'Store details updated by admin',
    body: 'An admin updated your store details. Review changes.',
    deepLink: '/retailer/store',
  });
  return ok(updated);
}

export async function pauseStore(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof PauseBody>;
  requestId: string;
}) {
  const store = await loadStoreOr404(input.id);
  if (store.status !== 'active') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `Cannot pause store in '${store.status}' status`,
    );
  }
  const [updated] = await db
    .update(retailerStores)
    .set({
      status: 'paused',
      pauseReason: input.body.reason,
      pauseVisibility: input.body.visibility,
      pauseUntil: input.body.until ? new Date(input.body.until) : null,
    })
    .where(eq(retailerStores.id, store.id))
    .returning();
  await recordAudit({
    actor: input.auth,
    action: 'store.pause',
    resourceKind: 'retailer_store',
    resourceId: store.id,
    before: { status: store.status },
    after: { status: 'paused', reason: input.body.reason },
    impersonatedStoreId: store.id,
    requestId: input.requestId,
  });
  await notifyOwners(store.id, {
    title: 'Store paused by admin',
    body: `Reason: ${input.body.reason}`,
    deepLink: '/retailer/store',
  });
  return ok(updated);
}

export async function resumeStore(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof OptionalReasonBody>;
  requestId: string;
}) {
  const store = await loadStoreOr404(input.id);
  if (store.status !== 'paused') {
    throw new AppError(409, ErrorCode.InvalidState, 'Store is not paused');
  }
  const [updated] = await db
    .update(retailerStores)
    .set({ status: 'active', pauseReason: null, pauseVisibility: null, pauseUntil: null })
    .where(eq(retailerStores.id, store.id))
    .returning();
  const body = input.body as { reason?: string };
  await recordAudit({
    actor: input.auth,
    action: 'store.resume',
    resourceKind: 'retailer_store',
    resourceId: store.id,
    before: { status: 'paused' },
    after: { status: 'active' },
    note: body.reason ?? null,
    impersonatedStoreId: store.id,
    requestId: input.requestId,
  });
  await notifyOwners(store.id, {
    title: 'Store resumed by admin',
    deepLink: '/retailer/store',
  });
  return ok(updated);
}

async function applySuspend(
  storeId: string,
  reason: string,
  actorSub: string,
  permanent: boolean,
): Promise<typeof retailerStores.$inferSelect> {
  const store = await loadStoreOr404(storeId);
  // Permanent kill → 'terminated' (consistent with terminateRetailer); temporary → 'suspended'.
  const targetStatus = permanent ? 'terminated' : 'suspended';
  if (store.status === targetStatus && store.permanentSuspend === permanent) {
    throw new AppError(409, ErrorCode.InvalidState, 'Store already in target state');
  }
  const [updated] = await db
    .update(retailerStores)
    .set({
      status: targetStatus,
      permanentSuspend: permanent,
      suspendReason: reason,
      suspendedAt: new Date(),
      suspendedByAccountId: actorSub,
    })
    .where(eq(retailerStores.id, store.id))
    .returning();
  return updated!;
}

export async function suspendStore(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof ReasonBody>;
  requestId: string;
}) {
  const updated = await applySuspend(input.id, input.body.reason, input.auth.sub, false);
  await recordAudit({
    actor: input.auth,
    action: 'store.suspend',
    resourceKind: 'retailer_store',
    resourceId: updated.id,
    after: { status: 'suspended', permanentSuspend: false },
    note: input.body.reason,
    impersonatedStoreId: updated.id,
    requestId: input.requestId,
  });
  await notifyOwners(updated.id, {
    title: 'Store suspended by admin',
    body: `Reason: ${input.body.reason}`,
    deepLink: '/retailer/store',
  });
  return ok(updated);
}

export async function banStore(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof ReasonBody>;
  requestId: string;
}) {
  const updated = await applySuspend(input.id, input.body.reason, input.auth.sub, true);
  await recordAudit({
    actor: input.auth,
    action: 'store.ban',
    resourceKind: 'retailer_store',
    resourceId: updated.id,
    after: { status: 'suspended', permanentSuspend: true },
    note: input.body.reason,
    impersonatedStoreId: updated.id,
    requestId: input.requestId,
  });
  await notifyOwners(updated.id, {
    title: 'Store banned by admin',
    body: `Reason: ${input.body.reason}`,
  });
  return ok(updated);
}

async function applyUnsuspend(
  storeId: string,
  actorSub: string,
): Promise<typeof retailerStores.$inferSelect> {
  const store = await loadStoreOr404(storeId);
  if (store.status !== 'suspended') {
    throw new AppError(409, ErrorCode.InvalidState, 'Store is not suspended');
  }
  const [updated] = await db
    .update(retailerStores)
    .set({
      status: 'active',
      permanentSuspend: false,
      suspendReason: null,
      suspendedAt: null,
      suspendedByAccountId: actorSub,
    })
    .where(eq(retailerStores.id, store.id))
    .returning();
  return updated!;
}

export async function unsuspendStore(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof OptionalReasonBody>;
  requestId: string;
}) {
  const updated = await applyUnsuspend(input.id, input.auth.sub);
  const body = input.body as { reason?: string };
  await recordAudit({
    actor: input.auth,
    action: 'store.unsuspend',
    resourceKind: 'retailer_store',
    resourceId: updated.id,
    after: { status: 'active' },
    note: body.reason ?? null,
    impersonatedStoreId: updated.id,
    requestId: input.requestId,
  });
  await notifyOwners(updated.id, {
    title: 'Store suspension lifted',
    deepLink: '/retailer/store',
  });
  return ok(updated);
}

export async function unbanStore(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof OptionalReasonBody>;
  requestId: string;
}) {
  const updated = await applyUnsuspend(input.id, input.auth.sub);
  const body = input.body as { reason?: string };
  await recordAudit({
    actor: input.auth,
    action: 'store.unban',
    resourceKind: 'retailer_store',
    resourceId: updated.id,
    after: { status: 'active', permanentSuspend: false },
    note: body.reason ?? null,
    impersonatedStoreId: updated.id,
    requestId: input.requestId,
  });
  await notifyOwners(updated.id, {
    title: 'Store ban lifted',
    body: 'Your store ban has been removed by admin.',
    deepLink: '/retailer/store',
  });
  return ok(updated);
}
