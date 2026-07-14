import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  accountAppealMessages,
  bankAccounts,
  changeRequests,
  kycReverifications,
  policyEnforcementActions,
  retailerAccounts,
  retailerStores,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { newId } from '@/shared/ids.js';
import { notifyAllAdmins } from '@/shared/notify-admins.js';
import { KYC_REQUIRED_DOC_KINDS } from '@/shared/kyc/doc-kinds.js';
import { shapeKycCycle } from '@/shared/kyc/serialize.js';
import { canSubmit, isWritableCycle } from '@/shared/kyc/state.js';
import { assertCycleAcceptsUploads, upsertKycDocument } from '@/shared/kyc/upload.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import {
  type AccountLifecycleBody,
  type AppealMessageBody,
  BankAccountValueSchema,
  type ChangeRequestBody,
  type KycUploadBody,
} from './compliance.validators.js';

type Auth = AccessTokenPayload;

async function loadStore(retailerId: string) {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
  });
  if (!retailer?.storeId) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, retailer.storeId),
  });
  if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  return store;
}

export async function getKyc(input: { auth: Auth }) {
  const store = await loadStore(input.auth.sub);
  const kyc = await db.query.kycReverifications.findFirst({
    where: eq(kycReverifications.storeId, store.id),
    orderBy: desc(kycReverifications.dueAt),
    with: { documents: true },
  });
  if (!kyc) return ok(null);
  // The shared serializer finally projects `decisionReason` and each document's
  // `reviewerNote` — without them a rejected retailer could never see WHY they failed.
  return ok({ ...shapeKycCycle(kyc), retailerId: input.auth.sub });
}

/** Load the retailer's own cycle (404s if it isn't theirs). */
async function loadOwnCycle(retailerId: string, cycleId: string) {
  const store = await loadStore(retailerId);
  const kyc = await db.query.kycReverifications.findFirst({
    where: and(eq(kycReverifications.id, cycleId), eq(kycReverifications.storeId, store.id)),
    with: { documents: true },
  });
  if (!kyc) throw new AppError(404, ErrorCode.NotFound, 'KYC reverification not found');
  return { store, kyc };
}

/**
 * Submit the cycle for review. Allowed from any state that awaits the retailer —
 * including `rejected`, which is the whole point: a rejection is a request to fix
 * specific documents, not a dead end.
 */
export async function submitKyc(input: { auth: Auth; id: string }) {
  const { store, kyc } = await loadOwnCycle(input.auth.sub, input.id);
  if (!isWritableCycle(kyc.status)) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      kyc.status === 'submitted'
        ? 'This KYC cycle is already under review'
        : 'This KYC cycle is closed',
    );
  }
  if (!canSubmit(kyc.documents, KYC_REQUIRED_DOC_KINDS)) {
    throw new AppError(
      422,
      ErrorCode.ValidationError,
      'Upload every required document — and replace any that were rejected — before submitting',
    );
  }

  const [updated] = await db
    .update(kycReverifications)
    .set({ status: 'submitted', submittedAt: new Date() })
    .where(eq(kycReverifications.id, kyc.id))
    .returning();

  // Nothing alerted the review desk before — a submitted cycle just sat there.
  await notifyAllAdmins({
    kind: 'compliance',
    title: 'KYC documents submitted',
    body: `${store.legalName} submitted their KYC documents for review.`,
    deepLink: `/admin/compliance/${kyc.id}`,
  }).catch(() => undefined);

  return ok(updated);
}

export async function uploadKycDocument(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof KycUploadBody>;
}) {
  const { kyc } = await loadOwnCycle(input.auth.sub, input.id);
  assertCycleAcceptsUploads(kyc.status);
  const doc = await upsertKycDocument(db, kyc.id, input.body.kind, input.body.url);
  return ok(doc);
}

export async function listChangeRequests(input: { auth: Auth }) {
  const store = await loadStore(input.auth.sub);
  const rows = await db.query.changeRequests.findMany({
    where: eq(changeRequests.storeId, store.id),
    orderBy: desc(changeRequests.submittedAt),
  });
  return ok(rows);
}

export async function getCurrentValues(input: { auth: Auth }) {
  const store = await loadStore(input.auth.sub);
  const bank = await db.query.bankAccounts.findFirst({
    where: and(eq(bankAccounts.storeId, store.id), eq(bankAccounts.isDefault, true)),
  });
  return ok({
    legalName: store.legalName,
    address: store.address,
    gstin: store.gstin,
    bank: bank
      ? {
          accountNumber: bank.accountNumber,
          ifsc: bank.ifsc,
          legalName: bank.legalName,
        }
      : null,
  });
}

export async function submitChangeRequest(input: {
  auth: Auth;
  body: z.infer<typeof ChangeRequestBody>;
}) {
  const { auth, body } = input;
  const store = await loadStore(auth.sub);

  // POS-billing activation is a feature request, not a profile-field edit — it carries no
  // GSTIN/bank payload. Reject if POS is already enabled so retailers can't queue a no-op.
  if (body.field === 'pos_billing_activation' && store.posBillingEnabled) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'POS billing is already enabled for this store',
    );
  }

  // Per-field validation on requestedValue.
  if (body.field === 'gstin') {
    if (!/^[0-9A-Z]{15}$/.test(body.requestedValue.trim().toUpperCase())) {
      throw AppError.validation('GSTIN must be 15 alphanumeric characters');
    }
  } else if (body.field === 'bank_account') {
    try {
      BankAccountValueSchema.parse(JSON.parse(body.requestedValue));
    } catch {
      throw AppError.validation(
        'Bank account requestedValue must be JSON with accountNumber, ifsc, legalName',
      );
    }
  }

  // One pending request per field at a time
  const existing = await db.query.changeRequests.findFirst({
    where: and(
      eq(changeRequests.storeId, store.id),
      eq(changeRequests.field, body.field),
      eq(changeRequests.status, 'pending'),
    ),
  });
  if (existing) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'A pending request for this field already exists',
    );
  }

  const normalisedRequested =
    body.field === 'gstin' ? body.requestedValue.trim().toUpperCase() : body.requestedValue;

  const id = newId('cr');
  await db.insert(changeRequests).values({
    id,
    storeId: store.id,
    field: body.field,
    currentValue: body.currentValue,
    requestedValue: normalisedRequested,
    reason: body.reason,
    evidenceUrl: body.evidenceUrl ?? null,
  });

  // Alert the admin team to a POS activation request (same pattern as new applications).
  // Best-effort — never block the retailer's submit on the notification.
  if (body.field === 'pos_billing_activation') {
    await notifyAllAdmins({
      kind: 'compliance',
      title: 'POS billing activation requested',
      body: `${store.legalName} requested POS/counter billing to be enabled.`,
      deepLink: '/admin/compliance?tab=change-requests',
    }).catch(() => undefined);
  }

  return ok({ id, status: 'pending' });
}

/** Load the requesting account + its store, asserting the caller may run account-lifecycle
 *  requests (owner or manager). Returns both rows. */
async function loadAccountForLifecycle(auth: Auth) {
  if (auth.subRole !== 'owner' && auth.subRole !== 'manager') {
    throw AppError.forbidden('Only the store owner or a manager can manage the business account');
  }
  const account = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, auth.sub),
  });
  if (!account?.storeId) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, account.storeId),
  });
  if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  return { account, store };
}

/** Reject a duplicate in-flight lifecycle request for the store. */
async function assertNoPendingLifecycleRequest(
  storeId: string,
  field: 'account_deletion' | 'account_reopen',
) {
  const existing = await db.query.changeRequests.findFirst({
    where: and(
      eq(changeRequests.storeId, storeId),
      eq(changeRequests.field, field),
      eq(changeRequests.status, 'pending'),
    ),
  });
  if (existing) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      field === 'account_deletion'
        ? 'An account-closure request is already pending review'
        : 'A reopen request is already pending review',
    );
  }
}

/**
 * Owner/manager requests closure of the business account. This does NOT delete or
 * suspend anything on its own — it files an `account_deletion` change request for admin
 * review. Approval (admin) suspends the store and closes every store account reversibly.
 */
export async function requestAccountClosure(input: {
  auth: Auth;
  body: z.infer<typeof AccountLifecycleBody>;
}) {
  const { account, store } = await loadAccountForLifecycle(input.auth);
  if (account.status !== 'active') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      account.status === 'closed'
        ? 'This account is already closed'
        : 'Only an active account can be closed',
    );
  }
  await assertNoPendingLifecycleRequest(store.id, 'account_deletion');

  const id = newId('cr');
  await db.insert(changeRequests).values({
    id,
    storeId: store.id,
    field: 'account_deletion',
    currentValue: store.status,
    requestedValue: 'closed',
    reason: input.body.reason ?? 'Owner-requested account closure',
  });

  await notifyAllAdmins({
    kind: 'compliance',
    title: 'Account closure requested',
    body: `${store.legalName} requested to close their business account.`,
    deepLink: '/admin/compliance?tab=change-requests',
  }).catch(() => undefined);

  return ok({ id, status: 'pending' });
}

/**
 * Owner/manager of a CLOSED account requests to reopen it. Files an `account_reopen`
 * change request; admin approval restores the store + all accounts to active.
 */
export async function requestAccountReopen(input: {
  auth: Auth;
  body: z.infer<typeof AccountLifecycleBody>;
}) {
  const { account, store } = await loadAccountForLifecycle(input.auth);
  if (account.status !== 'closed') {
    throw new AppError(409, ErrorCode.InvalidState, 'Only a closed account can be reopened');
  }
  await assertNoPendingLifecycleRequest(store.id, 'account_reopen');

  const id = newId('cr');
  await db.insert(changeRequests).values({
    id,
    storeId: store.id,
    field: 'account_reopen',
    currentValue: 'closed',
    requestedValue: 'active',
    reason: input.body.reason ?? 'Owner-requested account reopen',
  });

  await notifyAllAdmins({
    kind: 'compliance',
    title: 'Account reopen requested',
    body: `${store.legalName} requested to reopen their closed business account.`,
    deepLink: '/admin/compliance?tab=change-requests',
  }).catch(() => undefined);

  return ok({ id, status: 'pending' });
}

export async function listPolicyEnforcement(input: { auth: Auth }) {
  const store = await loadStore(input.auth.sub);
  const rows = await db.query.policyEnforcementActions.findMany({
    where: eq(policyEnforcementActions.storeId, store.id),
    orderBy: (t, { desc }) => [desc(t.actedAt)],
  });
  return ok(rows);
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

/** The retailer's appeal thread for a suspended/terminated store (read-only accounts can open it). */
export async function getAccountAppeal(input: { auth: Auth }) {
  const store = await loadStore(input.auth.sub);
  const msgs = await db.query.accountAppealMessages.findMany({
    where: eq(accountAppealMessages.storeId, store.id),
    orderBy: (t, { asc }) => [asc(t.at)],
  });
  return ok({
    storeStatus: store.status,
    canAppeal: store.status === 'suspended' || store.status === 'terminated',
    messages: msgs.map(serializeAppealMessage),
  });
}

/** Post an appeal message. Allowed only while the store is suspended/terminated. */
export async function postAccountAppeal(input: {
  auth: Auth;
  body: z.infer<typeof AppealMessageBody>;
}) {
  const store = await loadStore(input.auth.sub);
  if (store.status !== 'suspended' && store.status !== 'terminated') {
    throw new AppError(409, ErrorCode.InvalidState, 'Appeals are only open for a suspended or terminated store');
  }
  const id = newId('apmsg');
  await db.insert(accountAppealMessages).values({
    id,
    storeId: store.id,
    authorKind: 'retailer',
    authorAccountId: input.auth.sub,
    body: input.body.body,
    attachmentUrls: input.body.attachmentUrls ?? null,
  });
  await notifyAllAdmins({
    kind: 'compliance',
    title: 'Store appeal received',
    body: `${store.legalName} replied on their suspension/termination appeal.`,
    deepLink: `/admin/stores/${store.id}`,
  }).catch(() => undefined);
  return ok({ id });
}
