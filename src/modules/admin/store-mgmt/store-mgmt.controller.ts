/**
 * Admin store-management: direct create, edit, pause, resume, suspend, ban, unsuspend, unban.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  accountAppealMessages,
  changeRequests,
  retailerAccounts,
  retailerStores,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { recordAudit } from '@/shared/audit.js';
import { isAllowed } from '@/shared/permissions.js';
import { notify } from '@/shared/notify.js';
import { notifyStoreAccounts } from '@/shared/notify-store.js';
import {
  accountTransition,
  storeTransition,
  type PauseOpts,
  type StoreAction,
  type SuspendOpts,
} from '@/shared/lifecycle/transitions.js';
import { reinstateRetailerCascade } from '@/shared/lifecycle/retailer-cascade.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  AppealMessageBody,
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

/** Load the store, run the transition through the central state machine, persist. */
async function applyStoreAction(
  storeId: string,
  action: StoreAction,
  opts: SuspendOpts & PauseOpts = {},
): Promise<typeof retailerStores.$inferSelect> {
  const store = await loadStoreOr404(storeId);
  // An owner-closure suspension is owned by the account-closure flow: lifting just the
  // store would put an orderable storefront live with every account on it closed.
  // The exit is approving the retailer's reopen request (which restores both sides).
  if (
    (action === 'unsuspend' || action === 'reinstate') &&
    store.status === 'suspended' &&
    store.suspendReason === 'account_closed_by_owner'
  ) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'This store is suspended because the owner closed the account. Approve their reopen request instead of unsuspending the store.',
    );
  }
  const patch = storeTransition(store.status, action, opts);
  const [updated] = await db
    .update(retailerStores)
    .set(patch)
    .where(eq(retailerStores.id, store.id))
    .returning();
  return updated!;
}

export async function pauseStore(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof PauseBody>;
  requestId: string;
}) {
  const updated = await applyStoreAction(input.id, 'pause', {
    reason: input.body.reason,
    visibility: input.body.visibility,
    until: input.body.until ? new Date(input.body.until) : null,
  });
  await recordAudit({
    actor: input.auth,
    action: 'store.pause',
    resourceKind: 'retailer_store',
    resourceId: updated.id,
    after: { status: 'paused', reason: input.body.reason },
    impersonatedStoreId: updated.id,
    requestId: input.requestId,
  });
  await notifyOwners(updated.id, {
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
  const updated = await applyStoreAction(input.id, 'resume');
  const body = input.body as { reason?: string };
  await recordAudit({
    actor: input.auth,
    action: 'store.resume',
    resourceKind: 'retailer_store',
    resourceId: updated.id,
    before: { status: 'paused' },
    after: { status: 'active' },
    note: body.reason ?? null,
    impersonatedStoreId: updated.id,
    requestId: input.requestId,
  });
  await notifyOwners(updated.id, {
    title: 'Store resumed by admin',
    deepLink: '/retailer/store',
  });
  return ok(updated);
}

export async function suspendStore(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof ReasonBody>;
  requestId: string;
}) {
  const updated = await applyStoreAction(input.id, 'suspend', {
    reason: input.body.reason,
    actorId: input.auth.sub,
  });
  await recordAudit({
    actor: input.auth,
    action: 'store.suspend',
    resourceKind: 'retailer_store',
    resourceId: updated.id,
    after: { status: 'suspended' },
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
  const updated = await applyStoreAction(input.id, 'terminate', {
    reason: input.body.reason,
    actorId: input.auth.sub,
  });
  await recordAudit({
    actor: input.auth,
    action: 'store.ban',
    resourceKind: 'retailer_store',
    resourceId: updated.id,
    after: { status: 'terminated' },
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

export async function unsuspendStore(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof OptionalReasonBody>;
  requestId: string;
}) {
  const updated = await applyStoreAction(input.id, 'unsuspend');
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
  // 'reinstate' accepts terminated OR suspended, so "Reinstate store" works whether
  // the store was banned directly or suspended and never lifted.
  const updated = await applyStoreAction(input.id, 'reinstate');
  const body = input.body as { reason?: string };
  await recordAudit({
    actor: input.auth,
    action: 'store.unban',
    resourceKind: 'retailer_store',
    resourceId: updated.id,
    after: { status: 'active' },
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

/**
 * THE one admin restore entry point — "Resume store operations". Whatever is holding
 * this store down (store state, account ban, owner closure — or a stack of them), one
 * call lifts the full chain so the operator never hunts for the right lever:
 *   owner account terminated → reinstate the account (cascade revives its marker stores)
 *   accounts closed by owner → reopen them + approve any pending reopen request
 *   then the store itself:     paused → resume · suspended → unsuspend ·
 *                              terminated → reinstate (explicit intent, even if the
 *                              store was independently banned)
 * Everything is reported back in `restoreActions` (primary first) for the UI toast.
 */
export async function restoreStore(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof OptionalReasonBody>;
  requestId: string;
}) {
  const store = await loadStoreOr404(input.id);
  const reason = (input.body as { reason?: string }).reason ?? null;

  const accounts = await db.query.retailerAccounts.findMany({
    where: eq(retailerAccounts.storeId, store.id),
    columns: { id: true, status: true },
  });
  const owner = accounts.find((a) => a.id === store.legalEntityId);
  const ownerTerminated = owner?.status === 'terminated';
  const anyClosed = accounts.some((a) => a.status === 'closed');
  const storeDown =
    store.status === 'paused' || store.status === 'suspended' || store.status === 'terminated';

  if (!storeDown && !ownerTerminated && !anyClosed) {
    throw new AppError(409, ErrorCode.InvalidState, 'Store is already operating');
  }

  // Route baseline is store_management.edit — enough for a plain paused→resume (the
  // old Resume button's permission). Anything touching suspensions, terminations or
  // account state keeps the stricter reinstate permission.
  const onlyPlainResume = store.status === 'paused' && !ownerTerminated && !anyClosed;
  if (!onlyPlainResume) {
    if (!(await isAllowed('admin', input.auth.subRole ?? '', 'retailer.reinstate'))) {
      throw new AppError(403, ErrorCode.Forbidden, 'Missing permission: retailer.reinstate');
    }
  }

  const actions: Array<
    'account_reinstated' | 'account_reopened' | 'resumed' | 'unsuspended' | 'reinstated'
  > = [];

  // Account layer first, so a partial failure leaves a state where clicking the
  // button again simply finishes the job.
  if (ownerTerminated) {
    await reinstateRetailerCascade(db, store.legalEntityId);
    actions.push('account_reinstated');
  }
  if (anyClosed) {
    await db.transaction(async (tx) => {
      await tx
        .update(retailerAccounts)
        .set(accountTransition('closed', 'reopen'))
        .where(
          and(eq(retailerAccounts.storeId, store.id), eq(retailerAccounts.status, 'closed')),
        );
      // A reopen request may be sitting on the desk — resolve it here so it doesn't
      // linger (or double-apply if decided later).
      await tx
        .update(changeRequests)
        .set({
          status: 'approved',
          decidedAt: new Date(),
          decidedByAccountId: input.auth.sub,
          decisionNote: 'Resolved by admin "Resume store operations"',
        })
        .where(
          and(
            eq(changeRequests.storeId, store.id),
            eq(changeRequests.field, 'account_reopen'),
            eq(changeRequests.status, 'pending'),
          ),
        );
    });
    actions.push('account_reopened');
  }

  // Store layer — reload first: the account cascade may already have revived it.
  // Direct transitions (not applyStoreAction): its closure guard exists to stop a
  // store-only lift, and this path has just handled the account side.
  const current = await loadStoreOr404(store.id);
  const storeLift =
    current.status === 'paused'
      ? ({ action: 'resume', mode: 'resumed' } as const)
      : current.status === 'suspended'
        ? ({ action: 'unsuspend', mode: 'unsuspended' } as const)
        : current.status === 'terminated'
          ? ({ action: 'reinstate', mode: 'reinstated' } as const)
          : null;
  if (storeLift) {
    await db
      .update(retailerStores)
      .set(storeTransition(current.status, storeLift.action))
      .where(eq(retailerStores.id, store.id));
    actions.push(storeLift.mode);
  }

  const updated = await loadStoreOr404(store.id);
  await recordAudit({
    actor: input.auth,
    action: 'store.restore',
    resourceKind: 'retailer_store',
    resourceId: updated.id,
    before: { status: store.status },
    after: { status: updated.status, actions },
    note: reason,
    impersonatedStoreId: updated.id,
    requestId: input.requestId,
  });
  const accountRestored = actions[0] === 'account_reinstated' || actions[0] === 'account_reopened';
  await notifyStoreAccounts({
    storeId: updated.id,
    kind: 'system',
    title: accountRestored ? 'Account restored — welcome back' : 'Store operations resumed',
    body: accountRestored
      ? 'ClosetX restored your account and store. You have full access again.'
      : 'ClosetX restored your store. You can fulfil orders again.',
    deepLink: '/retailer/store/status',
  }).catch(() => undefined);

  return ok({ ...updated, restoreMode: actions[0], restoreActions: actions });
}

/** Canonical wire shape for one appeal-thread message (admin ↔ retailer). */
function serializeAppealMessage(m: {
  id: string;
  storeId: string;
  authorKind: string;
  body: string;
  attachmentUrls: string[] | null;
  at: Date;
}) {
  return {
    id: m.id,
    storeId: m.storeId,
    authorKind: m.authorKind === 'admin' ? 'admin' : m.authorKind === 'system' ? 'system' : 'retailer',
    body: m.body,
    attachments: m.attachmentUrls ?? [],
    createdAt: m.at.toISOString(),
  };
}

/**
 * Appeal threads awaiting an ADMIN reply — the queue feed for the Pending Requests
 * desk. A thread is "awaiting admin" when its most recent message was written by the
 * retailer. Appeals used to surface only as notifications; if an admin missed one,
 * it was invisible unless they happened to open that store's page.
 */
export async function listPendingAppeals() {
  const messages = await db.query.accountAppealMessages.findMany({
    orderBy: (t, { desc }) => [desc(t.at)],
    limit: 500,
    columns: { storeId: true, authorKind: true, body: true, at: true },
  });
  // Latest message per store (rows arrive newest-first).
  const latest = new Map<string, (typeof messages)[number]>();
  for (const m of messages) if (!latest.has(m.storeId)) latest.set(m.storeId, m);
  const awaiting = [...latest.values()].filter((m) => m.authorKind === 'retailer');
  if (awaiting.length === 0) return ok([]);

  const stores = await db.query.retailerStores.findMany({
    where: inArray(retailerStores.id, awaiting.map((m) => m.storeId)),
    columns: { id: true, legalName: true, status: true },
  });
  const byId = new Map(stores.map((s) => [s.id, s]));
  return ok(
    awaiting
      // An appeal is only actionable while the store is actually down. Once it's
      // restored (by any path), a trailing retailer message is moot — the thread
      // stays readable on the store page but must not sit on the desk forever.
      .filter((m) => {
        const status = byId.get(m.storeId)?.status;
        return status === 'suspended' || status === 'terminated';
      })
      .map((m) => ({
        storeId: m.storeId,
        storeName: byId.get(m.storeId)?.legalName ?? null,
        storeStatus: byId.get(m.storeId)?.status ?? null,
        lastMessageAt: m.at.toISOString(),
        lastMessagePreview: m.body.slice(0, 140),
      })),
  );
}

/** Admin view of a store's suspend/terminate appeal thread. */
export async function getStoreAppeal(input: { id: string }) {
  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, input.id),
    columns: { id: true, status: true, legalName: true },
  });
  if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  const msgs = await db.query.accountAppealMessages.findMany({
    where: eq(accountAppealMessages.storeId, store.id),
    orderBy: asc(accountAppealMessages.at),
  });
  return ok({ storeStatus: store.status, messages: msgs.map(serializeAppealMessage) });
}

/** Admin reply in a store's appeal thread. */
export async function postStoreAppeal(input: {
  id: string;
  auth: Auth;
  body: z.infer<typeof AppealMessageBody>;
}) {
  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, input.id),
    columns: { id: true },
  });
  if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  const id = newId('apmsg');
  await db.insert(accountAppealMessages).values({
    id,
    storeId: store.id,
    authorKind: 'admin',
    authorAccountId: input.auth.sub,
    body: input.body.body,
    attachmentUrls: input.body.attachmentUrls ?? null,
  });
  await notifyStoreAccounts({
    storeId: store.id,
    kind: 'system',
    title: 'Appeal update from ClosetX',
    body: 'The ClosetX team replied on your store appeal. Open the app to read it.',
    deepLink: '/retailer/store/status',
  }).catch(() => undefined);
  return ok({ id });
}
