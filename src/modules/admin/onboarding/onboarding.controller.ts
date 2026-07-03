import { asc, desc, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  applicationMessages,
  applicationVerificationChecks,
  bankAccounts,
  retailerAccounts,
  retailerApplications,
  retailerStores,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { hashPassword } from '@/shared/auth/password.js';
import { newId } from '@/shared/ids.js';
import { recordAudit } from '@/shared/audit.js';
import { notify } from '@/shared/notify.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  ApproveBody,
  ListApplicationsQuery,
  MessageBody,
  RejectBody,
  UpdateStatusBody,
  VerificationCheckBody,
} from './onboarding.validators.js';

type Auth = AccessTokenPayload;

function shapeApplicationSummary(
  r: {
    id: string;
    legalName: string;
    ownerEmail: string;
    ownerPhone: string;
    gstin: string;
    pan: string | null;
    addressLine: string;
    pincode: string;
    stateCode: string;
    submittedAt: Date;
    status: string;
    documents: Array<{ id: string }>;
    checks: Array<{ kind: string; status: string }>;
    messages: Array<{ id: string; authorKind: string }>;
  },
) {
  const pennyCheck = r.checks.filter((c) => c.kind === 'bank_penny_drop').pop();
  const gstinCheck = r.checks.filter((c) => c.kind === 'gstin').pop();
  return {
    id: r.id,
    legalName: r.legalName,
    email: r.ownerEmail,
    phone: r.ownerPhone,
    gstin: r.gstin,
    pan: r.pan ?? null,
    addressLine: r.addressLine,
    pincode: r.pincode,
    stateCode: r.stateCode,
    submittedAt: r.submittedAt.toISOString(),
    status: r.status,
    documentsCount: r.documents.length,
    clarificationCount: r.messages.filter((m) => m.authorKind === 'admin').length,
    pennyDropResult: !pennyCheck
      ? 'not_attempted'
      : pennyCheck.status === 'verified'
        ? 'matched'
        : pennyCheck.status === 'failed'
          ? 'failed'
          : 'not_attempted',
    gstinVerification: !gstinCheck
      ? 'not_attempted'
      : gstinCheck.status === 'verified'
        ? 'valid'
        : gstinCheck.status === 'failed'
          ? 'invalid'
          : 'not_attempted',
  };
}

export async function listApplications(input: {
  query: z.infer<typeof ListApplicationsQuery>;
}) {
  const { status, limit } = input.query;
  const rows = await db.query.retailerApplications.findMany({
    where: status ? eq(retailerApplications.status, status) : undefined,
    orderBy: desc(retailerApplications.submittedAt),
    limit,
    with: {
      documents: { columns: { id: true } },
      checks: { columns: { kind: true, status: true } },
      messages: { columns: { id: true, authorKind: true } },
    },
  });
  return ok(rows.map(shapeApplicationSummary));
}

export async function getApplication(id: string) {
  const r = await db.query.retailerApplications.findFirst({
    where: eq(retailerApplications.id, id),
    with: {
      documents: true,
      checks: true,
      messages: { orderBy: asc(applicationMessages.at) },
    },
  });
  if (!r) throw new AppError(404, ErrorCode.NotFound, 'Application not found');

  const summary = shapeApplicationSummary(r);
  return ok({
    ...summary,
    documents: r.documents,
    messages: r.messages.map((m) => ({
      id: m.id,
      applicationId: m.applicationId,
      authorKind: m.authorKind,
      authorLabel: m.authorKind === 'admin' ? 'ClosetX admin' : 'Applicant',
      body: m.body,
      attachments: m.attachmentUrls ?? [],
      fieldKey: null as string | null,
      createdAt: m.at.toISOString(),
    })),
  });
}

export async function updateApplicationStatus(input: {
  id: string;
  auth: Auth;
  body: z.infer<typeof UpdateStatusBody>;
  requestId: string;
}) {
  const { id, auth, body, requestId } = input;
  const application = await db.query.retailerApplications.findFirst({
    where: eq(retailerApplications.id, id),
  });
  if (!application) throw new AppError(404, ErrorCode.NotFound, 'Application not found');
  const before = { status: application.status };
  const [updated] = await db
    .update(retailerApplications)
    .set({ status: body.status })
    .where(eq(retailerApplications.id, application.id))
    .returning();
  await recordAudit({
    actor: auth,
    action: `application.${body.status}`,
    resourceKind: 'retailer_application',
    resourceId: application.id,
    before,
    after: { status: body.status },
    note: body.reason ?? null,
    requestId,
  });
  return ok(updated);
}

export async function approveApplication(input: {
  id: string;
  auth: Auth;
  body: z.infer<typeof ApproveBody>;
  requestId: string;
  log: FastifyBaseLogger;
}) {
  const { id, auth, body, requestId, log } = input;
  log.info({ applicationId: id }, 'approve: starting');
  const application = await db.query.retailerApplications.findFirst({
    where: eq(retailerApplications.id, id),
  });
  if (!application) throw new AppError(404, ErrorCode.NotFound, 'Application not found');
  log.info(
    { status: application.status, hasPasswordHash: !!application.passwordHash },
    'approve: application found',
  );
  if (application.status === 'approved') {
    throw new AppError(409, ErrorCode.InvalidState, 'Application already approved');
  }
  // Approving a rejected application is intentionally allowed — admin may override
  // their own prior rejection without forcing the applicant to resubmit.

  // Block provisioning if an account already exists with the applicant's email or phone.
  const emailCollision = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.email, application.ownerEmail),
    columns: { id: true },
  });
  if (emailCollision) {
    throw new AppError(
      409,
      ErrorCode.EmailAlreadyTaken,
      'A retailer account with this email already exists — approval would create a duplicate.',
    );
  }
  const phoneCollision = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.phone, application.ownerPhone),
    columns: { id: true },
  });
  if (phoneCollision) {
    throw new AppError(
      409,
      ErrorCode.EmailAlreadyTaken,
      'A retailer account with this phone already exists — approval would create a duplicate.',
    );
  }

  const retailerId = newId('ret');
  const storeId = newId('str');

  // Use applicant-set password if present; otherwise require tempPassword from admin.
  const passwordHash = application.passwordHash
    ? application.passwordHash
    : body.tempPassword
      ? await hashPassword(body.tempPassword)
      : (() => {
          throw new AppError(
            400,
            ErrorCode.ValidationError,
            'tempPassword required: applicant did not set a password during signup',
          );
        })();

  log.info({ storeId, retailerId }, 'approve: inserting retailerStores');
  await db.insert(retailerStores).values({
    id: storeId,
    legalEntityId: retailerId,
    legalName: application.storeName ?? application.legalName,
    gstin: application.gstin,
    pan: application.pan ?? null,
    address: application.addressLine,
    stateCode: application.stateCode,
    lat: application.lat ? parseFloat(application.lat) : 0,
    lng: application.lng ? parseFloat(application.lng) : 0,
    openingHours:
      (application.hours as Record<string, { open: string; close: string }[]>) ?? null,
    status: 'onboarding',
    platformFeeBp: body.platformFeeBp,
    // Store's own contact — use the application's dedicated store contact if given,
    // else fall back to the owner phone so the store carries an independent copy.
    contactPhone: application.contactPhone ?? application.ownerPhone,
    ...(application.managerName ? { managerName: application.managerName } : {}),
  });
  log.info('approve: retailerStores inserted');

  if (
    application.bankAccountNumber &&
    application.bankIfsc &&
    application.bankLegalName
  ) {
    log.info('approve: inserting bankAccounts');
    await db.insert(bankAccounts).values({
      id: newId('bnk'),
      storeId,
      accountNumber: application.bankAccountNumber,
      ifsc: application.bankIfsc,
      legalName: application.bankLegalName,
      isDefault: true,
    });
    log.info('approve: bankAccounts inserted');
  }

  log.info({ retailerId, email: application.ownerEmail }, 'approve: inserting retailerAccounts');
  await db.insert(retailerAccounts).values({
    id: retailerId,
    email: application.ownerEmail,
    passwordHash,
    legalName: application.legalName,
    phone: application.ownerPhone,
    gstin: application.gstin,
    storeId,
    subRole: 'owner',
    status: 'active',
  });
  log.info('approve: retailerAccounts inserted');

  await db
    .update(retailerApplications)
    .set({
      status: 'approved',
      decidedAt: new Date(),
      decidedByAccountId: auth.sub,
      decisionReason: body.note ?? null,
      provisionedRetailerAccountId: retailerId,
    })
    .where(eq(retailerApplications.id, application.id));

  log.info('approve: application status updated');
  await recordAudit({
    actor: auth,
    action: 'application.approve',
    resourceKind: 'retailer_application',
    resourceId: application.id,
    after: { provisionedRetailerId: retailerId, provisionedStoreId: storeId },
    note: body.note ?? null,
    requestId,
  });

  await notify({
    recipientKind: 'retailer',
    recipientId: retailerId,
    kind: 'kyc',
    title: 'Application approved — welcome to ClosetX!',
    body: 'Your retailer account is ready. Complete your store profile to go live.',
    deepLink: '/retailer/dashboard',
    payload: { storeId },
  });

  return ok({
    retailerId,
    storeId,
    message: 'Application approved; retailer account and store provisioned',
  });
}

export async function rejectApplication(input: {
  id: string;
  auth: Auth;
  body: z.infer<typeof RejectBody>;
  requestId: string;
}) {
  const { id, auth, body, requestId } = input;
  const application = await db.query.retailerApplications.findFirst({
    where: eq(retailerApplications.id, id),
  });
  if (!application) throw new AppError(404, ErrorCode.NotFound, 'Application not found');
  if (application.status === 'approved') {
    throw new AppError(409, ErrorCode.InvalidState, 'Cannot reject an approved application');
  }
  // Dedupe doc-kinds defensively in case the client sends duplicates.
  const mustReupload = Array.from(new Set(body.mustReuploadDocKinds ?? []));
  const [updated] = await db
    .update(retailerApplications)
    .set({
      status: 'rejected',
      decidedAt: new Date(),
      decidedByAccountId: auth.sub,
      decisionReason: body.reason,
      mustReuploadDocKinds: mustReupload,
    })
    .where(eq(retailerApplications.id, application.id))
    .returning();
  await recordAudit({
    actor: auth,
    action: 'application.reject',
    resourceKind: 'retailer_application',
    resourceId: application.id,
    after: { reason: body.reason, mustReuploadDocKinds: mustReupload },
    requestId,
  });
  return ok(updated);
}

export async function postMessage(input: {
  id: string;
  auth: Auth;
  body: z.infer<typeof MessageBody>;
}) {
  const { id, auth, body } = input;
  const application = await db.query.retailerApplications.findFirst({
    where: eq(retailerApplications.id, id),
  });
  if (!application) throw new AppError(404, ErrorCode.NotFound, 'Application not found');
  const newMessageId = newId('amsg');
  await db.insert(applicationMessages).values({
    id: newMessageId,
    applicationId: application.id,
    authorKind: 'admin',
    authorAccountId: auth.sub,
    body: body.body,
    attachmentUrls: body.attachmentUrls ?? null,
  });
  return ok({ id: newMessageId });
}

export async function recordVerificationCheck(input: {
  id: string;
  body: z.infer<typeof VerificationCheckBody>;
}) {
  const { id, body } = input;
  const application = await db.query.retailerApplications.findFirst({
    where: eq(retailerApplications.id, id),
  });
  if (!application) throw new AppError(404, ErrorCode.NotFound, 'Application not found');
  const checkId = newId('vchk');
  const now = new Date();
  await db.insert(applicationVerificationChecks).values({
    id: checkId,
    applicationId: application.id,
    kind: body.kind,
    status: body.status,
    rawResponse: body.rawResponse ?? null,
    errorCode: body.errorCode ?? null,
    finishedAt: ['verified', 'failed'].includes(body.status) ? now : null,
  });
  return ok({ id: checkId, kind: body.kind, status: body.status });
}
