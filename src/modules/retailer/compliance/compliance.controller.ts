import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  bankAccounts,
  changeRequests,
  kycDocuments,
  kycReverifications,
  policyEnforcementActions,
  retailerAccounts,
  retailerStores,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { notifyAllAdmins } from '@/shared/notify-admins.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import {
  BankAccountValueSchema,
  type ChangeRequestBody,
  type KycUploadBody,
} from './compliance.validators.js';

type Auth = AccessTokenPayload;

/** Human labels for the standard KYC document kinds the dashboard renders. */
const KYC_DOC_LABELS: Record<string, string> = {
  gstin_certificate: 'GSTIN Certificate',
  pan_card: 'PAN Card',
  address_proof: 'Address Proof',
  cancelled_cheque: 'Cancelled Cheque',
  shop_act_license: 'Shop & Establishment License',
};

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
  return ok({
    id: kyc.id,
    retailerId: input.auth.sub,
    status: kyc.status,
    dueAt: kyc.dueAt.toISOString(),
    gracePeriodEndsAt: kyc.gracePeriodEndsAt.toISOString(),
    lastVerifiedAt: kyc.lastVerifiedAt ? kyc.lastVerifiedAt.toISOString() : null,
    documents: kyc.documents.map((d) => ({
      id: d.id,
      kind: d.kind,
      label: KYC_DOC_LABELS[d.kind] ?? d.kind.replace(/_/g, ' '),
      status: d.status,
      uploadedAt: d.uploadedAt ? d.uploadedAt.toISOString() : null,
      fileUrl: d.url,
    })),
  });
}

export async function submitKyc(input: { auth: Auth; id: string }) {
  const store = await loadStore(input.auth.sub);
  const kyc = await db.query.kycReverifications.findFirst({
    where: and(
      eq(kycReverifications.id, input.id),
      eq(kycReverifications.storeId, store.id),
    ),
  });
  if (!kyc) throw new AppError(404, ErrorCode.NotFound, 'KYC reverification not found');
  if (kyc.status !== 'pending') {
    throw new AppError(409, ErrorCode.InvalidState, 'KYC cycle already submitted or decided');
  }
  const [updated] = await db
    .update(kycReverifications)
    .set({ status: 'submitted', submittedAt: new Date() })
    .where(eq(kycReverifications.id, kyc.id))
    .returning();
  return ok(updated);
}

export async function uploadKycDocument(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof KycUploadBody>;
}) {
  const store = await loadStore(input.auth.sub);
  const kyc = await db.query.kycReverifications.findFirst({
    where: and(
      eq(kycReverifications.id, input.id),
      eq(kycReverifications.storeId, store.id),
    ),
  });
  if (!kyc) throw new AppError(404, ErrorCode.NotFound, 'KYC cycle not found');
  if (kyc.status !== 'pending') {
    throw new AppError(409, ErrorCode.InvalidState, 'KYC cycle is not accepting uploads');
  }
  const existing = await db.query.kycDocuments.findFirst({
    where: and(
      eq(kycDocuments.reverificationId, kyc.id),
      eq(kycDocuments.kind, input.body.kind),
    ),
  });
  if (existing) {
    const [doc] = await db
      .update(kycDocuments)
      .set({ url: input.body.url, status: 'pending_review', uploadedAt: new Date() })
      .where(eq(kycDocuments.id, existing.id))
      .returning();
    return ok(doc);
  }
  const [doc] = await db
    .insert(kycDocuments)
    .values({
      id: newId(IdPrefix.KycDocument),
      reverificationId: kyc.id,
      kind: input.body.kind,
      url: input.body.url,
      status: 'pending_review',
      uploadedAt: new Date(),
    })
    .returning();
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

export async function listPolicyEnforcement(input: { auth: Auth }) {
  const store = await loadStore(input.auth.sub);
  const rows = await db.query.policyEnforcementActions.findMany({
    where: eq(policyEnforcementActions.storeId, store.id),
    orderBy: (t, { desc }) => [desc(t.actedAt)],
  });
  return ok(rows);
}
