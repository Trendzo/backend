import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  accountDeletionRequests,
  adminAccounts,
  bankAccounts,
  changeRequests,
  consumers,
  dataExportRequests,
  kycDocuments,
  kycReverifications,
  policyEnforcementActions,
  retailerAccounts,
  retailerStores,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { recordAudit } from '@/shared/audit.js';
import { notifyStoreAccounts } from '@/shared/notify-store.js';
import {
  type AdminChangeRequestBody,
  BankAccountValueSchema,
  type ChangeRequestDecideBody,
  type ChangeRequestStatusQuery,
  type DataExportProcessBody,
  type DeletionCancelBody,
  type KycDecideBody,
  type PolicyEnforcementBody,
  type PolicyEnforcementQuery,
  type ReverifyBody,
} from './compliance.validators.js';
import type { Auth, RawCycle } from './compliance.types.js';

const KYC_REQUIRED_DOC_KINDS = [
  'gstin_certificate',
  'pan_card',
  'address_proof',
  'cancelled_cheque',
  'shop_act_license',
] as const;

/** Human-readable labels for the canonical 5 KYC doc kinds. Mirrors the same
 *  mapping in the retailer-side handler so both portals see identical labels. */
const KYC_DOC_LABELS: Record<string, string> = {
  gstin_certificate: 'GSTIN Certificate',
  pan_card: 'PAN Card',
  address_proof: 'Address Proof',
  cancelled_cheque: 'Cancelled Cheque',
  shop_act_license: 'Shop & Establishment License',
};

/**
 * Open a new KYC re-verification cycle for `storeId`, or revive the most recent
 * approved/rejected one. Idempotent on already-pending cycles (only updates the
 * deadlines). Seeds required document slots when starting fresh or when the
 * existing cycle has zero docs.
 */
async function openOrRefreshKycCycle(
  storeId: string,
  dueDays = 14,
  graceDays = 30,
): Promise<string> {
  const now = new Date();
  const dueAt = new Date(now.getTime() + dueDays * 24 * 60 * 60 * 1000);
  const graceEndsAt = new Date(now.getTime() + graceDays * 24 * 60 * 60 * 1000);

  const existing = await db.query.kycReverifications.findFirst({
    where: eq(kycReverifications.storeId, storeId),
    orderBy: desc(kycReverifications.dueAt),
  });

  let cycleId: string;
  let seedDocs = false;

  if (!existing || existing.status === 'approved' || existing.status === 'rejected') {
    cycleId = newId(IdPrefix.KycReverification);
    await db.insert(kycReverifications).values({
      id: cycleId,
      storeId,
      status: 'pending',
      dueAt,
      gracePeriodEndsAt: graceEndsAt,
      lastVerifiedAt: existing?.decidedAt ?? null,
    });
    seedDocs = true;
  } else {
    cycleId = existing.id;
    await db
      .update(kycReverifications)
      .set({
        status: 'pending',
        dueAt,
        gracePeriodEndsAt: graceEndsAt,
        submittedAt: null,
        decidedAt: null,
        decidedByAccountId: null,
        decisionReason: null,
      })
      .where(eq(kycReverifications.id, existing.id));
    const docCount = await db.$count(
      kycDocuments,
      eq(kycDocuments.reverificationId, existing.id),
    );
    if (docCount === 0) seedDocs = true;
  }

  if (seedDocs) {
    await db.insert(kycDocuments).values(
      KYC_REQUIRED_DOC_KINDS.map((kind) => ({
        id: newId(IdPrefix.KycDocument),
        reverificationId: cycleId,
        kind,
        status: 'missing' as const,
      })),
    );
  }

  return cycleId;
}

function shapeCycle(
  row: RawCycle,
  store: { id: string; legalName: string } | null,
) {
  return {
    id: row.id,
    storeId: row.storeId,
    storeName: store?.legalName ?? null,
    status: row.status,
    dueAt: row.dueAt.toISOString(),
    gracePeriodEndsAt: row.gracePeriodEndsAt.toISOString(),
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decisionReason: row.decisionReason,
    lastVerifiedAt: row.lastVerifiedAt ? row.lastVerifiedAt.toISOString() : null,
    documents: row.documents.map((d) => ({
      id: d.id,
      kind: d.kind,
      label: KYC_DOC_LABELS[d.kind] ?? d.kind.replace(/_/g, ' '),
      status: d.status,
      uploadedAt: d.uploadedAt ? d.uploadedAt.toISOString() : null,
      fileUrl: d.url,
    })),
  };
}

export async function listKycCycles() {
  const rows = await db.query.kycReverifications.findMany({
    orderBy: asc(kycReverifications.dueAt),
    with: { documents: true },
  });
  if (rows.length === 0) return ok([]);
  const storeIds = [...new Set(rows.map((r) => r.storeId))];
  const stores = await db.query.retailerStores.findMany({
    where: inArray(retailerStores.id, storeIds),
    columns: { id: true, legalName: true },
  });
  const byId = new Map(stores.map((s) => [s.id, s]));
  return ok(rows.map((r) => shapeCycle(r as RawCycle, byId.get(r.storeId) ?? null)));
}

export async function getKycCycle(id: string) {
  const row = await db.query.kycReverifications.findFirst({
    where: eq(kycReverifications.id, id),
    with: { documents: true },
  });
  if (!row) throw new AppError(404, ErrorCode.NotFound, 'KYC reverification not found');
  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, row.storeId),
    columns: { id: true, legalName: true },
  });
  return ok(shapeCycle(row as RawCycle, store ?? null));
}

export async function decideKyc(input: {
  id: string;
  auth: Auth;
  body: z.infer<typeof KycDecideBody>;
  requestId: string;
}) {
  const { id, auth, body, requestId } = input;
  const kyc = await db.query.kycReverifications.findFirst({
    where: eq(kycReverifications.id, id),
  });
  if (!kyc) throw new AppError(404, ErrorCode.NotFound, 'KYC reverification not found');
  const now = new Date();
  const [updated] = await db
    .update(kycReverifications)
    .set({
      status: body.decision,
      decidedAt: now,
      decidedByAccountId: auth.sub,
      decisionReason: body.reason ?? null,
      lastVerifiedAt: body.decision === 'approved' ? now : null,
    })
    .where(eq(kycReverifications.id, kyc.id))
    .returning();
  await recordAudit({
    actor: auth,
    action: `kyc.${body.decision}`,
    resourceKind: 'kyc_reverification',
    resourceId: kyc.id,
    after: { status: body.decision },
    requestId,
  });
  return ok(updated);
}

export async function listChangeRequests(input: {
  query: z.infer<typeof ChangeRequestStatusQuery>;
}) {
  const rows = await db.query.changeRequests.findMany({
    where: input.query.status ? eq(changeRequests.status, input.query.status) : undefined,
    orderBy: desc(changeRequests.submittedAt),
    with: { store: { columns: { id: true, legalName: true, gstin: true } } },
  });
  return ok(
    rows.map((r) => ({
      ...r,
      storeName: r.store?.legalName ?? null,
    })),
  );
}

export async function getChangeRequest(id: string) {
  const row = await db.query.changeRequests.findFirst({
    where: eq(changeRequests.id, id),
    with: {
      store: { columns: { id: true, legalName: true, address: true, gstin: true } },
    },
  });
  if (!row) throw new AppError(404, ErrorCode.NotFound, 'Change request not found');
  return ok({
    ...row,
    storeName: row.store?.legalName ?? null,
  });
}

/**
 * Admin files a change request on behalf of a store (the "with change request"
 * edit path). Mirrors the retailer-side submit (per-field validation, one-pending-
 * per-field guard) but derives `currentValue` from the store row. The resulting
 * pending row flows through the normal `decideChangeRequest` approve→apply path.
 */
export async function createChangeRequest(input: {
  storeId: string;
  auth: Auth;
  body: z.infer<typeof AdminChangeRequestBody>;
  requestId: string;
}) {
  const { storeId, auth, body, requestId } = input;

  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, storeId),
  });
  if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');

  // Per-field validation on requestedValue (mirrors retailer submitChangeRequest).
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

  // One pending request per field at a time.
  const existing = await db.query.changeRequests.findFirst({
    where: and(
      eq(changeRequests.storeId, storeId),
      eq(changeRequests.field, body.field),
      eq(changeRequests.status, 'pending'),
    ),
  });
  if (existing) {
    throw new AppError(409, ErrorCode.InvalidState, 'A pending request for this field already exists');
  }

  // Snapshot the current value so the change-request card shows a from→to diff.
  let currentValue: string;
  if (body.field === 'legal_name') currentValue = store.legalName;
  else if (body.field === 'address') currentValue = store.address;
  else if (body.field === 'gstin') currentValue = store.gstin;
  else {
    const bank = await db.query.bankAccounts.findFirst({
      where: and(eq(bankAccounts.storeId, storeId), eq(bankAccounts.isDefault, true)),
    });
    currentValue = bank
      ? JSON.stringify({ accountNumber: bank.accountNumber, ifsc: bank.ifsc, legalName: bank.legalName })
      : '—';
  }

  const normalisedRequested =
    body.field === 'gstin' ? body.requestedValue.trim().toUpperCase() : body.requestedValue;

  const id = newId('cr');
  await db.insert(changeRequests).values({
    id,
    storeId,
    field: body.field,
    currentValue,
    requestedValue: normalisedRequested,
    reason: body.reason,
  });

  await recordAudit({
    actor: auth,
    action: 'change_request.admin_created',
    resourceKind: 'change_request',
    resourceId: id,
    after: { field: body.field, requestedValue: normalisedRequested },
    impersonatedStoreId: storeId,
    requestId,
  });

  return ok({ id, status: 'pending' as const });
}

export async function decideChangeRequest(input: {
  id: string;
  auth: Auth;
  body: z.infer<typeof ChangeRequestDecideBody>;
  requestId: string;
}) {
  const { id, auth, body, requestId } = input;
  const now = new Date();

  const updated = await db.transaction(async (tx) => {
    const cr = await tx.query.changeRequests.findFirst({
      where: eq(changeRequests.id, id),
    });
    if (!cr) throw new AppError(404, ErrorCode.NotFound, 'Change request not found');
    if (cr.status !== 'pending') {
      throw new AppError(409, ErrorCode.InvalidState, 'Change request already decided');
    }

    if (body.decision === 'approved') {
      if (cr.field === 'legal_name') {
        await tx
          .update(retailerStores)
          .set({ legalName: cr.requestedValue })
          .where(eq(retailerStores.id, cr.storeId));
      } else if (cr.field === 'address') {
        await tx
          .update(retailerStores)
          .set({ address: cr.requestedValue })
          .where(eq(retailerStores.id, cr.storeId));
      } else if (cr.field === 'gstin') {
        await tx
          .update(retailerStores)
          .set({ gstin: cr.requestedValue })
          .where(eq(retailerStores.id, cr.storeId));
      } else if (cr.field === 'bank_account') {
        let parsed: z.infer<typeof BankAccountValueSchema>;
        try {
          parsed = BankAccountValueSchema.parse(JSON.parse(cr.requestedValue));
        } catch {
          throw AppError.validation(
            'Stored bank_account requestedValue is not a valid JSON blob — refusing to apply',
          );
        }
        // Clear current default first to honour the partial unique index
        // (one default bank account per store), then insert the new default.
        await tx
          .update(bankAccounts)
          .set({ isDefault: false })
          .where(
            and(eq(bankAccounts.storeId, cr.storeId), eq(bankAccounts.isDefault, true)),
          );
        await tx.insert(bankAccounts).values({
          id: newId(IdPrefix.BankAccount),
          storeId: cr.storeId,
          accountNumber: parsed.accountNumber,
          ifsc: parsed.ifsc,
          legalName: parsed.legalName,
          isDefault: true,
          verifiedAt: now,
        });
      } else if (cr.field === 'pos_billing_activation') {
        // Approving the request flips the store's POS opt-in on.
        await tx
          .update(retailerStores)
          .set({ posBillingEnabled: true })
          .where(eq(retailerStores.id, cr.storeId));
      } else if (cr.field === 'account_deletion') {
        // Reversible closure: suspend the store (NOT terminate/permanentSuspend) and
        // close every store account. Records are kept so the owner can reopen. The
        // suspendReason is intentionally NOT 'account_deleted_by_user' so login is not
        // blocked (assertRetailerNotDeleted) — a closed owner must still sign in to
        // file a reopen request.
        await tx
          .update(retailerStores)
          .set({
            status: 'suspended',
            permanentSuspend: false,
            suspendReason: 'account_closed_by_owner',
            suspendedAt: now,
            suspendedByAccountId: auth.sub,
          })
          .where(eq(retailerStores.id, cr.storeId));
        await tx
          .update(retailerAccounts)
          .set({
            status: 'closed',
            permanentSuspend: false,
            suspendReason: 'account_closed_by_owner',
            suspendedAt: now,
            suspendedByAccountId: auth.sub,
          })
          .where(eq(retailerAccounts.storeId, cr.storeId));
      } else if (cr.field === 'account_reopen') {
        // Restore the store + all its accounts to active, clearing the closure marks.
        await tx
          .update(retailerStores)
          .set({
            status: 'active',
            permanentSuspend: false,
            suspendReason: null,
            suspendedAt: null,
            suspendedByAccountId: null,
            pauseReason: null,
          })
          .where(eq(retailerStores.id, cr.storeId));
        await tx
          .update(retailerAccounts)
          .set({
            status: 'active',
            permanentSuspend: false,
            suspendReason: null,
            suspendedAt: null,
            suspendedByAccountId: null,
          })
          .where(eq(retailerAccounts.storeId, cr.storeId));
      }
    }

    const [row] = await tx
      .update(changeRequests)
      .set({
        status: body.decision,
        decidedAt: now,
        decidedByAccountId: auth.sub,
        decisionNote: body.note ?? null,
      })
      .where(eq(changeRequests.id, cr.id))
      .returning();
    return row;
  });

  await recordAudit({
    actor: auth,
    action: `change_request.${body.decision}`,
    resourceKind: 'change_request',
    resourceId: id,
    after: { status: body.decision },
    requestId,
  });

  // Tell the store when a POS activation request is decided (best-effort).
  if (updated?.field === 'pos_billing_activation') {
    await notifyStoreAccounts({
      storeId: updated.storeId,
      kind: 'system',
      title: body.decision === 'approved' ? 'POS billing enabled' : 'POS billing request declined',
      body:
        body.decision === 'approved'
          ? 'Your POS/counter billing request was approved — the Register is now in your dashboard.'
          : `Your POS billing request was declined.${body.note ? ` Note: ${body.note}` : ''}`,
      deepLink: body.decision === 'approved' ? '/retailer/pos' : '/retailer/store/status',
    }).catch(() => undefined);
  }

  // Tell the store when a closure/reopen request is decided (best-effort).
  if (updated?.field === 'account_deletion') {
    await notifyStoreAccounts({
      storeId: updated.storeId,
      kind: 'system',
      title: body.decision === 'approved' ? 'Account closed' : 'Closure request declined',
      body:
        body.decision === 'approved'
          ? 'Your account-closure request was approved. Your store is now suspended. You can request to reopen anytime from the app.'
          : `Your account-closure request was declined.${body.note ? ` Note: ${body.note}` : ''}`,
      deepLink: '/retailer/store/status',
    }).catch(() => undefined);
  }
  if (updated?.field === 'account_reopen') {
    await notifyStoreAccounts({
      storeId: updated.storeId,
      kind: 'system',
      title: body.decision === 'approved' ? 'Account reopened' : 'Reopen request declined',
      body:
        body.decision === 'approved'
          ? 'Your reopen request was approved — your store and account are active again. Welcome back!'
          : `Your reopen request was declined.${body.note ? ` Note: ${body.note}` : ''}`,
      deepLink: '/retailer/store/status',
    }).catch(() => undefined);
  }

  return ok(updated);
}

export async function listPolicyEnforcement(input: {
  query: z.infer<typeof PolicyEnforcementQuery>;
}) {
  const rows = await db.query.policyEnforcementActions.findMany({
    where: input.query.storeId
      ? eq(policyEnforcementActions.storeId, input.query.storeId)
      : undefined,
    orderBy: desc(policyEnforcementActions.actedAt),
  });
  if (rows.length === 0) return ok([]);

  // Bulk-resolve every store + owner + admin actor in three queries rather
  // than per-row joins. The dashboard renders enforcement history flat, so
  // duplicates here are common.
  const storeIds = [...new Set(rows.map((r) => r.storeId))];
  const adminIds = [
    ...new Set(rows.map((r) => r.actedByAccountId).filter((v): v is string => !!v)),
  ];

  const stores = await db.query.retailerStores.findMany({
    where: inArray(retailerStores.id, storeIds),
    columns: { id: true, legalName: true },
  });
  const owners = await db.query.retailerAccounts.findMany({
    where: and(
      inArray(retailerAccounts.storeId, storeIds),
      eq(retailerAccounts.subRole, 'owner'),
    ),
    columns: { id: true, storeId: true, legalName: true, email: true },
  });
  const admins =
    adminIds.length === 0
      ? []
      : await db.query.adminAccounts.findMany({
          where: inArray(adminAccounts.id, adminIds),
          columns: { id: true, email: true },
        });

  const storeById = new Map(stores.map((s) => [s.id, s]));
  const ownerByStore = new Map(owners.map((o) => [o.storeId, o]));
  const adminById = new Map(admins.map((a) => [a.id, a]));

  return ok(
    rows.map((r) => {
      const store = storeById.get(r.storeId);
      const owner = ownerByStore.get(r.storeId);
      const actor = r.actedByAccountId ? adminById.get(r.actedByAccountId) : null;
      return {
        ...r,
        storeName: store?.legalName ?? null,
        retailerId: owner?.id ?? null,
        retailerName: owner?.legalName ?? null,
        retailerEmail: owner?.email ?? null,
        actorName: actor?.email ?? null,
      };
    }),
  );
}

export async function createPolicyEnforcement(input: {
  auth: Auth;
  body: z.infer<typeof PolicyEnforcementBody>;
  requestId: string;
}) {
  const { auth, body, requestId } = input;
  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, body.storeId),
  });
  if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');

  const id = newId('enf');
  await db.insert(policyEnforcementActions).values({
    id,
    storeId: store.id,
    step: body.step,
    breachKind: body.breachKind,
    metric: body.metric ?? null,
    actedByAccountId: auth.sub,
    reason: body.reason ?? null,
    liftsActionId: body.liftsActionId ?? null,
  });

  if (body.step === 'suspension') {
    await db
      .update(retailerStores)
      .set({ status: 'suspended' })
      .where(eq(retailerStores.id, store.id));
  } else if (body.step === 'termination') {
    await db
      .update(retailerStores)
      .set({ status: 'terminated' })
      .where(eq(retailerStores.id, store.id));
  } else if (body.step === 'lifted') {
    await db
      .update(retailerStores)
      .set({ status: 'active' })
      .where(eq(retailerStores.id, store.id));
  }

  // If the breach is kyc_overdue and the step isn't 'lifted', open or refresh
  // a KYC re-verification cycle so the retailer sees the banner + page.
  if (body.breachKind === 'kyc_overdue' && body.step !== 'lifted') {
    await openOrRefreshKycCycle(store.id);
  }

  await recordAudit({
    actor: auth,
    action: `enforcement.${body.step}`,
    resourceKind: 'retailer_store',
    resourceId: store.id,
    after: { step: body.step },
    requestId,
  });

  return ok({ id });
}

export async function triggerReverify(input: {
  storeId: string;
  auth: Auth;
  body: z.infer<typeof ReverifyBody>;
  requestId: string;
}) {
  const { storeId, auth, body, requestId } = input;
  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, storeId),
  });
  if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');

  const cycleId = await openOrRefreshKycCycle(store.id, body.dueDays, body.graceDays);

  await recordAudit({
    actor: auth,
    action: 'kyc.reverify_triggered',
    resourceKind: 'retailer_store',
    resourceId: store.id,
    after: { cycleId, reason: body.reason, dueDays: body.dueDays ?? 14 },
    requestId,
  });

  return ok({ cycleId, storeId: store.id });
}

export async function listDataExports() {
  const rows = await db.query.dataExportRequests.findMany({
    orderBy: desc(dataExportRequests.requestedAt),
  });
  if (rows.length === 0) return ok([]);
  const consumerIds = [...new Set(rows.map((r) => r.consumerId))];
  const consumerRows = await db.query.consumers.findMany({
    where: inArray(consumers.id, consumerIds),
    columns: { id: true, name: true, email: true, phone: true },
  });
  const byId = new Map(consumerRows.map((c) => [c.id, c]));
  return ok(
    rows.map((r) => {
      const c = byId.get(r.consumerId);
      return {
        ...r,
        consumerName: c?.name ?? null,
        consumerEmail: c?.email ?? null,
        consumerPhone: c?.phone ?? null,
      };
    }),
  );
}

export async function processDataExport(input: {
  id: string;
  body: z.infer<typeof DataExportProcessBody>;
}) {
  const { id, body } = input;
  const row = await db.query.dataExportRequests.findFirst({
    where: eq(dataExportRequests.id, id),
  });
  if (!row) throw new AppError(404, ErrorCode.NotFound, 'Data export not found');

  const now = new Date();
  const expiresAt =
    body.status === 'ready'
      ? new Date(now.getTime() + body.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

  const [updated] = await db
    .update(dataExportRequests)
    .set({
      status: body.status,
      readyAt: body.status === 'ready' ? now : null,
      downloadUrl: body.downloadUrl ?? null,
      failureReason: body.failureReason ?? null,
      expiresAt,
    })
    .where(eq(dataExportRequests.id, row.id))
    .returning();

  return ok(updated);
}

export async function listAccountDeletions() {
  const rows = await db.query.accountDeletionRequests.findMany({
    orderBy: asc(accountDeletionRequests.scheduledFor),
  });
  if (rows.length === 0) return ok([]);
  const consumerIds = [...new Set(rows.map((r) => r.consumerId))];
  const consumerRows = await db.query.consumers.findMany({
    where: inArray(consumers.id, consumerIds),
    columns: { id: true, name: true, email: true, phone: true },
  });
  const byId = new Map(consumerRows.map((c) => [c.id, c]));
  return ok(
    rows.map((r) => {
      const c = byId.get(r.consumerId);
      return {
        ...r,
        consumerName: c?.name ?? null,
        consumerEmail: c?.email ?? null,
        consumerPhone: c?.phone ?? null,
      };
    }),
  );
}

export async function completeAccountDeletion(id: string) {
  const row = await db.query.accountDeletionRequests.findFirst({
    where: eq(accountDeletionRequests.id, id),
  });
  if (!row) throw new AppError(404, ErrorCode.NotFound, 'Deletion request not found');
  if (row.status === 'completed') {
    throw new AppError(409, ErrorCode.InvalidState, 'Already completed');
  }
  const [updated] = await db
    .update(accountDeletionRequests)
    .set({ status: 'completed', completedAt: new Date() })
    .where(eq(accountDeletionRequests.id, row.id))
    .returning();

  // Anonymise consumer PII (simplified: overwrite sensitive fields)
  if (updated) {
    await db
      .update(consumers)
      .set({
        email: `deleted+${row.id}@deleted.invalid`,
        phone: '0000000000',
        name: '[Deleted]',
        status: 'closed',
      })
      .where(eq(consumers.id, row.consumerId));
  }
  return ok(updated);
}

export async function cancelAccountDeletion(input: {
  id: string;
  auth: Auth;
  body: z.infer<typeof DeletionCancelBody>;
  requestId: string;
}) {
  const { id, auth, body, requestId } = input;
  const row = await db.query.accountDeletionRequests.findFirst({
    where: eq(accountDeletionRequests.id, id),
  });
  if (!row) throw new AppError(404, ErrorCode.NotFound, 'Deletion request not found');
  if (row.status !== 'pending') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `Cannot cancel — request is already ${row.status}`,
    );
  }
  const [updated] = await db
    .update(accountDeletionRequests)
    .set({ status: 'cancelled', cancelledAt: new Date() })
    .where(eq(accountDeletionRequests.id, row.id))
    .returning();
  await recordAudit({
    actor: auth,
    action: 'account_deletion.cancel',
    resourceKind: 'account_deletion_request',
    resourceId: row.id,
    after: { status: 'cancelled', reason: body?.reason ?? null },
    requestId,
  });
  return ok(updated);
}
