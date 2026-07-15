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
import { accountTransition, storeTransition } from '@/shared/lifecycle/transitions.js';
import { loadKycConfig } from '@/shared/kyc/config.js';
import { KYC_REQUIRED_DOC_KINDS, kycDocLabel } from '@/shared/kyc/doc-kinds.js';
import { resumeStoreAfterKyc } from '@/shared/kyc/enforcement.js';
import { shapeKycCycle } from '@/shared/kyc/serialize.js';
import { allRequiredVerified, isDecidableCycle } from '@/shared/kyc/state.js';
import {
  type AdminChangeRequestBody,
  BankAccountValueSchema,
  type ChangeRequestDecideBody,
  type ChangeRequestStatusQuery,
  type DataExportProcessBody,
  type DeletionCancelBody,
  type KycDecideBody,
  type KycDocumentDecideBody,
  type KycStatusQuery,
  type PolicyEnforcementBody,
  type PolicyEnforcementQuery,
  type ReverifyBody,
} from './compliance.validators.js';
import type { Auth, RawCycle } from './compliance.types.js';

/**
 * Open a KYC re-verification cycle for `storeId`.
 *
 * A NEW cycle is only started when there is no live one — i.e. the latest is `approved`
 * or absent. Previously a `rejected` cycle also triggered a fresh insert, which orphaned
 * the cycle **and every document the retailer had uploaded**. That was the only escape
 * hatch from a rejection, because rejection was a dead end; now that `rejected` is a
 * working state the retailer just fixes it in place, and a re-trigger on a live cycle
 * simply extends its deadline.
 */
async function openOrRefreshKycCycle(
  storeId: string,
  dueDaysOverride?: number,
  graceDaysOverride?: number,
): Promise<string> {
  const cfg = await loadKycConfig();
  const dueDays = dueDaysOverride ?? cfg.dueDays;
  const graceDays = graceDaysOverride ?? cfg.graceDays;

  const now = new Date();
  const dueAt = new Date(now.getTime() + dueDays * 24 * 60 * 60 * 1000);
  const graceEndsAt = new Date(dueAt.getTime() + graceDays * 24 * 60 * 60 * 1000);

  const existing = await db.query.kycReverifications.findFirst({
    where: eq(kycReverifications.storeId, storeId),
    orderBy: desc(kycReverifications.dueAt),
  });

  let cycleId: string;
  let seedDocs = false;

  if (!existing || existing.status === 'approved') {
    cycleId = newId(IdPrefix.KycReverification);
    await db.insert(kycReverifications).values({
      id: cycleId,
      storeId,
      status: 'pending',
      dueAt,
      gracePeriodEndsAt: graceEndsAt,
      lastVerifiedAt: existing?.lastVerifiedAt ?? existing?.decidedAt ?? null,
    });
    seedDocs = true;
  } else {
    // A live cycle (pending / submitted / rejected / overdue): extend the deadline and
    // hand it back to the retailer. Their uploads and per-document review outcomes stay.
    cycleId = existing.id;
    await db
      .update(kycReverifications)
      .set({ status: 'pending', dueAt, gracePeriodEndsAt: graceEndsAt })
      .where(eq(kycReverifications.id, existing.id));
    const docCount = await db.$count(kycDocuments, eq(kycDocuments.reverificationId, existing.id));
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

export async function listKycCycles(input: { query: z.infer<typeof KycStatusQuery> }) {
  const rows = await db.query.kycReverifications.findMany({
    where: input.query.status ? eq(kycReverifications.status, input.query.status) : undefined,
    orderBy: asc(kycReverifications.dueAt),
    limit: input.query.limit,
    with: { documents: true },
  });
  if (rows.length === 0) return ok([]);
  const storeIds = [...new Set(rows.map((r) => r.storeId))];
  const stores = await db.query.retailerStores.findMany({
    where: inArray(retailerStores.id, storeIds),
    columns: { id: true, legalName: true },
  });
  const byId = new Map(stores.map((s) => [s.id, s]));
  return ok(rows.map((r) => shapeKycCycle(r as RawCycle, byId.get(r.storeId) ?? null)));
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
  return ok(shapeKycCycle(row as RawCycle, store ?? null));
}

/**
 * Review ONE document. This endpoint did not exist — which is why `decideKyc` had to
 * blanket-stamp every document with the cycle-level reason, and why an admin could never
 * say "PAN is fine, address proof is blurry".
 */
export async function decideKycDocument(input: {
  id: string;
  docId: string;
  auth: Auth;
  body: z.infer<typeof KycDocumentDecideBody>;
  requestId: string;
}) {
  const { id, docId, auth, body, requestId } = input;
  const kyc = await db.query.kycReverifications.findFirst({
    where: eq(kycReverifications.id, id),
  });
  if (!kyc) throw new AppError(404, ErrorCode.NotFound, 'KYC reverification not found');
  if (!isDecidableCycle(kyc.status)) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'Documents can only be reviewed while the cycle is submitted for review',
    );
  }
  const doc = await db.query.kycDocuments.findFirst({
    where: and(eq(kycDocuments.id, docId), eq(kycDocuments.reverificationId, kyc.id)),
  });
  if (!doc) throw new AppError(404, ErrorCode.NotFound, 'Document not found on this cycle');
  if (doc.status === 'missing') {
    throw new AppError(409, ErrorCode.InvalidState, 'Nothing was uploaded for this document');
  }

  const [updated] = await db
    .update(kycDocuments)
    .set({
      status: body.decision,
      reviewedAt: new Date(),
      reviewerNote: body.note ?? null,
    })
    .where(eq(kycDocuments.id, doc.id))
    .returning();

  await recordAudit({
    actor: auth,
    action: `kyc.document.${body.decision}`,
    resourceKind: 'kyc_document',
    resourceId: doc.id,
    before: { status: doc.status },
    after: { status: body.decision, note: body.note ?? null },
    requestId,
  });

  return ok(updated);
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
    with: { documents: true },
  });
  if (!kyc) throw new AppError(404, ErrorCode.NotFound, 'KYC reverification not found');
  if (!isDecidableCycle(kyc.status)) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      kyc.status === 'approved' || kyc.status === 'rejected'
        ? 'This KYC cycle has already been decided'
        : 'This KYC cycle has not been submitted for review yet',
    );
  }

  // The decision is DERIVED from the per-document review — it no longer blanket-stamps
  // the documents (that would stomp the reviewer's individual verify/reject calls).
  if (body.decision === 'approved' && !allRequiredVerified(kyc.documents, KYC_REQUIRED_DOC_KINDS)) {
    throw new AppError(
      422,
      ErrorCode.ValidationError,
      'Verify every required document before approving the cycle',
    );
  }
  if (body.decision === 'rejected' && !kyc.documents.some((d) => d.status === 'rejected')) {
    throw new AppError(
      422,
      ErrorCode.ValidationError,
      'Reject at least one document so the retailer knows what to fix',
    );
  }

  const now = new Date();
  const [updated] = await db
    .update(kycReverifications)
    .set({
      status: body.decision,
      decidedAt: now,
      decidedByAccountId: auth.sub,
      decisionReason: body.reason ?? null,
      // Only an approval advances lastVerifiedAt. A rejection used to NULL it, wiping
      // the store's last known-good verification.
      ...(body.decision === 'approved' && { lastVerifiedAt: now }),
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

  // An approval lifts a KYC auto-pause (and only a KYC auto-pause). Best-effort so a
  // resume hiccup can't fail the recorded decision — but LOUD, because the retailer
  // cannot self-resume a kyc_overdue pause and would otherwise be stuck silently.
  if (body.decision === 'approved') {
    await resumeStoreAfterKyc(db, kyc.storeId).catch((err: unknown) => {
      console.error(
        `[kyc] approved cycle ${kyc.id} but auto-resume of store ${kyc.storeId} FAILED — lift the pause manually: ${(err as Error).message}`,
      );
    });
  }

  // The KYC path notified nobody, ever. Best-effort, never blocks the decision.
  const rejectedLabels = kyc.documents
    .filter((d) => d.status === 'rejected')
    .map((d) => kycDocLabel(d.kind))
    .join(', ');
  await notifyStoreAccounts({
    storeId: kyc.storeId,
    kind: 'kyc',
    title: body.decision === 'approved' ? 'KYC approved' : 'KYC needs changes',
    body:
      body.decision === 'approved'
        ? 'Your KYC re-verification was approved. Nothing further is needed.'
        : `Re-upload and re-submit: ${rejectedLabels}.${body.reason ? ` Note: ${body.reason}` : ''}`,
    deepLink: '/retailer/store/kyc',
  }).catch(() => undefined);

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
        // Reversible closure: suspend the store (NOT terminate) and close every ACTIVE
        // store account. Records are kept so the owner can reopen. The suspendReason is
        // intentionally NOT 'account_deleted_by_user' so login is not blocked
        // (assertRetailerNotDeleted) — a closed owner must still sign in to file a
        // reopen request. Patches come from the central state machine, driven by the
        // store's REAL status (a store terminated since the request was filed 409s
        // here instead of being silently downgraded to suspended).
        const closingStore = await tx.query.retailerStores.findFirst({
          where: eq(retailerStores.id, cr.storeId),
          columns: { status: true },
        });
        if (!closingStore) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
        // Already suspended (admin action) or terminated? The store is already at
        // least as locked as closure requires — keep the existing state + reason
        // rather than 409ing the whole approval.
        if (closingStore.status !== 'suspended' && closingStore.status !== 'terminated') {
          await tx
            .update(retailerStores)
            .set(
              storeTransition(closingStore.status, 'suspend', {
                reason: 'account_closed_by_owner',
                actorId: auth.sub,
              }),
            )
            .where(eq(retailerStores.id, cr.storeId));
        }
        // Only ACTIVE accounts close — a previously terminated staff account must not
        // be laundered into 'closed' (and later resurrected by a reopen).
        await tx
          .update(retailerAccounts)
          .set(
            accountTransition('active', 'close', {
              reason: 'account_closed_by_owner',
              actorId: auth.sub,
            }),
          )
          .where(
            and(eq(retailerAccounts.storeId, cr.storeId), eq(retailerAccounts.status, 'active')),
          );
      } else if (cr.field === 'account_reopen') {
        // Mirror of closure: unsuspend the store, reopen only the CLOSED accounts.
        const reopeningStore = await tx.query.retailerStores.findFirst({
          where: eq(retailerStores.id, cr.storeId),
          columns: { status: true },
        });
        if (!reopeningStore) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
        // Only lift the closure suspension if it is still in place. An admin may have
        // manually unsuspended the store already (→ skip, don't 409 the account out of
        // its only exit path) or terminated it meanwhile (→ the account reopens but the
        // store termination stands until an admin reinstates it explicitly).
        if (reopeningStore.status === 'suspended') {
          await tx
            .update(retailerStores)
            .set(storeTransition(reopeningStore.status, 'unsuspend'))
            .where(eq(retailerStores.id, cr.storeId));
        }
        await tx
          .update(retailerAccounts)
          .set(accountTransition('closed', 'reopen'))
          .where(
            and(eq(retailerAccounts.storeId, cr.storeId), eq(retailerAccounts.status, 'closed')),
          );
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

  // Compute the status patch FIRST — an illegal transition must 409 before anything
  // is written — then persist ledger row + status change atomically, so a failure
  // can't leave an enforcement row whose status change never happened.
  let statusPatch: Record<string, unknown> | null = null;
  if (body.step === 'suspension') {
    statusPatch = storeTransition(store.status, 'suspend', {
      reason: body.reason ?? `policy_enforcement:${body.breachKind}`,
      actorId: auth.sub,
    });
  } else if (body.step === 'termination') {
    statusPatch = storeTransition(store.status, 'terminate', {
      reason: body.reason ?? `policy_enforcement:${body.breachKind}`,
      actorId: auth.sub,
    });
  } else if (body.step === 'lifted') {
    // Lifting a warning-step leaves an already-active store untouched; only a
    // suspension/termination actually needs reversing.
    if (store.status === 'suspended' || store.status === 'terminated') {
      statusPatch = storeTransition(store.status, 'reinstate');
    }
  }

  const id = newId('enf');
  await db.transaction(async (tx) => {
    await tx.insert(policyEnforcementActions).values({
      id,
      storeId: store.id,
      step: body.step,
      breachKind: body.breachKind,
      metric: body.metric ?? null,
      actedByAccountId: auth.sub,
      reason: body.reason ?? null,
      liftsActionId: body.liftsActionId ?? null,
    });
    if (statusPatch) {
      await tx.update(retailerStores).set(statusPatch).where(eq(retailerStores.id, store.id));
    }
  });

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
    after: { cycleId, reason: body.reason, dueDays: body.dueDays ?? null },
    requestId,
  });

  // The retailer was never told KYC had been asked for — they only found out by
  // happening to open the app and notice the banner.
  await notifyStoreAccounts({
    storeId: store.id,
    kind: 'kyc',
    title: 'KYC re-verification requested',
    body: `ClosetX needs your KYC documents re-verified. Reason: ${body.reason}`,
    deepLink: '/retailer/store/kyc',
  }).catch(() => undefined);

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
