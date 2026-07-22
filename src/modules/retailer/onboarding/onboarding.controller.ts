import { and, asc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  applicationDocuments,
  applicationMessages,
  retailerAccounts,
  retailerApplications,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { newId } from '@/shared/ids.js';
import { hashPassword, verifyPassword } from '@/shared/auth/password.js';
import { notifyAllAdmins } from '@/shared/notify-admins.js';
import { recordAudit } from '@/shared/audit.js';
import { serializeApplicationMessage } from '@/shared/onboarding/messages.js';
import { currentLegalDoc } from '@/shared/terms.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  CheckIdentityQuery,
  FetchForResubmitBody,
  MessagesQuery,
  OwnMessageBody,
  PostMessageBody,
  ResubmitBody,
  StatusQuery,
  SubmitApplicationBody,
  SubmitDocumentsBody,
} from './onboarding.validators.js';

type Auth = AccessTokenPayload;

type IdentityCollision = {
  accountEmailTaken: boolean;
  accountPhoneTaken: boolean;
  appEmail: { id: string; status: string } | null;
  appPhone: { id: string; status: string } | null;
};

/**
 * Resolve which identifier(s) collide, per field, across both approved accounts
 * and existing applications. Kept field-granular (not a single OR) so the caller
 * can tell the user EXACTLY which of email/phone is taken and offer the matching
 * login method.
 */
async function resolveIdentityCollision(
  email: string | undefined,
  phone: string | undefined,
): Promise<IdentityCollision> {
  const [acctEmail, acctPhone, appEmail, appPhone] = await Promise.all([
    email
      ? db.query.retailerAccounts.findFirst({
          where: eq(retailerAccounts.email, email),
          columns: { id: true },
        })
      : Promise.resolve(undefined),
    phone
      ? db.query.retailerAccounts.findFirst({
          where: eq(retailerAccounts.phone, phone),
          columns: { id: true },
        })
      : Promise.resolve(undefined),
    email
      ? db.query.retailerApplications.findFirst({
          where: eq(retailerApplications.ownerEmail, email),
          columns: { id: true, status: true },
        })
      : Promise.resolve(undefined),
    phone
      ? db.query.retailerApplications.findFirst({
          where: eq(retailerApplications.ownerPhone, phone),
          columns: { id: true, status: true },
        })
      : Promise.resolve(undefined),
  ]);
  return {
    accountEmailTaken: !!acctEmail,
    accountPhoneTaken: !!acctPhone,
    appEmail: appEmail ?? null,
    appPhone: appPhone ?? null,
  };
}

/** Human message naming exactly which identifier(s) are already registered. */
function identifierTakenMessage(emailTaken: boolean, phoneTaken: boolean): string {
  if (emailTaken && phoneTaken) return 'This email and phone number are both already registered.';
  if (emailTaken) return 'This email is already registered.';
  if (phoneTaken) return 'This phone number is already registered.';
  return 'These details are already registered.';
}

export async function submitApplication(input: {
  body: z.infer<typeof SubmitApplicationBody>;
}) {
  const { body } = input;
  // Block duplicate submissions — but say EXACTLY which identifier collides so the
  // UI can point the user at the right recovery (log in / status page / re-apply).
  const col = await resolveIdentityCollision(body.ownerEmail, body.ownerPhone);
  const appEmailActive = col.appEmail != null && col.appEmail.status !== 'rejected';
  const appPhoneActive = col.appPhone != null && col.appPhone.status !== 'rejected';

  // 1) An approved/active ACCOUNT owns one or both identifiers → they must sign in.
  if (col.accountEmailTaken || col.accountPhoneTaken) {
    throw new AppError(
      409,
      ErrorCode.SignupIdentifierTaken,
      identifierTakenMessage(col.accountEmailTaken, col.accountPhoneTaken),
      {
        emailTaken: col.accountEmailTaken,
        phoneTaken: col.accountPhoneTaken,
        accountEmailTaken: col.accountEmailTaken,
        accountPhoneTaken: col.accountPhoneTaken,
        accountExists: true,
      },
    );
  }

  // 2) An application under review (pending/approved-but-not-yet-account) is on file.
  if (appEmailActive || appPhoneActive) {
    const hit = (appEmailActive ? col.appEmail : col.appPhone)!;
    throw new AppError(
      409,
      ErrorCode.ApplicationPending,
      `${identifierTakenMessage(appEmailActive, appPhoneActive)} An application is already on file — check its status.`,
      {
        emailTaken: appEmailActive,
        phoneTaken: appPhoneActive,
        accountExists: false,
        applicationId: hit.id,
        applicationStatus: hit.status,
      },
    );
  }

  // 3) Only a REJECTED application matches → sign in on the status page to re-apply.
  if (col.appEmail?.status === 'rejected' || col.appPhone?.status === 'rejected') {
    const hit = (col.appEmail?.status === 'rejected' ? col.appEmail : col.appPhone)!;
    throw new AppError(
      409,
      ErrorCode.ApplicationRejected,
      'A previous application with this email or phone was rejected. Sign in on the status page to re-apply on the same record.',
      { applicationId: hit.id },
    );
  }

  const id = newId('app');
  const passwordHash = body.password ? await hashPassword(body.password) : null;
  // Consent given on the signup form — pin the doc versions current right now, so
  // approval can seed acceptances and first login is not gated on the same versions.
  const consent = body.acceptLegal
    ? {
        legalConsentAt: new Date(),
        consentTermsVersion: (await currentLegalDoc(db, 'terms')).version,
        consentPrivacyVersion: (await currentLegalDoc(db, 'privacy')).version,
      }
    : {};
  await db.insert(retailerApplications).values({
    id,
    ...consent,
    legalName: body.legalName,
    storeName: body.storeName ?? null,
    gstin: body.gstin,
    pan: body.pan ?? null,
    ownerName: body.ownerName,
    ownerEmail: body.ownerEmail,
    ownerPhone: body.ownerPhone,
    addressLine: body.addressLine,
    pincode: body.pincode,
    stateCode: body.stateCode,
    lat: body.lat ?? null,
    lng: body.lng ?? null,
    hours: body.hours ?? null,
    categories: body.categories ?? null,
    brands: body.brands ?? null,
    sampleSkus: body.sampleSkus ?? null,
    contactPhone: body.contactPhone ?? null,
    managerName: body.managerName ?? null,
    bankLegalName: body.bankLegalName ?? null,
    bankAccountNumber: body.bankAccountNumber ?? null,
    bankIfsc: body.bankIfsc ?? null,
    passwordHash,
  });
  if (body.documents?.length) {
    await db.insert(applicationDocuments).values(
      body.documents.map((d) => ({
        id: newId('adoc'),
        applicationId: id,
        kind: d.kind,
        url: d.url,
      })),
    );
  }
  await notifyAllAdmins({
    kind: 'system',
    title: 'New retailer application',
    body: `${body.legalName} (${body.ownerEmail}) submitted an application.`,
    deepLink: `/admin/onboarding/${id}`,
    payload: { applicationId: id, legalName: body.legalName, ownerEmail: body.ownerEmail },
  });
  return ok({ id, status: 'pending', message: 'Application submitted successfully' });
}

export async function getApplicationStatus(input: {
  id: string;
  query: z.infer<typeof StatusQuery>;
}) {
  const application = await db.query.retailerApplications.findFirst({
    where: eq(retailerApplications.id, input.id),
  });
  if (!application || application.ownerEmail !== input.query.email) {
    throw new AppError(404, ErrorCode.NotFound, 'Application not found');
  }
  return ok({
    id: application.id,
    status: application.status,
    submittedAt: application.submittedAt,
    decidedAt: application.decidedAt,
    decisionReason: application.decisionReason,
    // Which document kinds the admin asked to (re)upload — drives the structured
    // upload slots in the app's docs_requested / resubmit screens.
    mustReuploadDocKinds: application.mustReuploadDocKinds ?? [],
  });
}

export async function checkIdentity(input: {
  query: z.infer<typeof CheckIdentityQuery>;
}) {
  const { email, phone } = input.query;
  if (!email && !phone) {
    return ok({
      emailTaken: false,
      phoneTaken: false,
      accountExists: false,
      accountEmailTaken: false,
      accountPhoneTaken: false,
      applicationStatus: null,
      applicationId: null,
    });
  }

  const col = await resolveIdentityCollision(email, phone);
  // Prefer the email hit for the reapply/status route, else the phone hit.
  const appHit = col.appEmail ?? col.appPhone;
  return ok({
    // Union (account OR any application, incl. rejected) — the gate the UI checks.
    emailTaken: col.accountEmailTaken || !!col.appEmail,
    phoneTaken: col.accountPhoneTaken || !!col.appPhone,
    accountExists: col.accountEmailTaken || col.accountPhoneTaken,
    // Field-granular account flags so the UI can offer the exact login method(s).
    accountEmailTaken: col.accountEmailTaken,
    accountPhoneTaken: col.accountPhoneTaken,
    applicationStatus: appHit?.status ?? null,
    applicationId: appHit?.id ?? null,
  });
}

export async function getPublicMessages(input: {
  id: string;
  query: z.infer<typeof MessagesQuery>;
}) {
  const application = await db.query.retailerApplications.findFirst({
    where: eq(retailerApplications.id, input.id),
  });
  if (!application || application.ownerEmail !== input.query.email) {
    throw new AppError(404, ErrorCode.NotFound, 'Application not found');
  }
  const messages = await db.query.applicationMessages.findMany({
    where: eq(applicationMessages.applicationId, application.id),
    orderBy: asc(applicationMessages.at),
  });
  return ok(messages.map(serializeApplicationMessage));
}

export async function getOwnApplicationMessages(input: { auth: Auth }) {
  const application = await db.query.retailerApplications.findFirst({
    where: eq(retailerApplications.provisionedRetailerAccountId, input.auth.sub),
  });
  if (!application) return ok([]);

  const msgs = await db.query.applicationMessages.findMany({
    where: eq(applicationMessages.applicationId, application.id),
    orderBy: asc(applicationMessages.at),
  });

  return ok(msgs.map(serializeApplicationMessage));
}

/** Authenticated retailer reply on their own application thread (web dashboard). */
export async function postOwnApplicationMessage(input: {
  auth: Auth;
  body: z.infer<typeof OwnMessageBody>;
}) {
  const application = await db.query.retailerApplications.findFirst({
    where: eq(retailerApplications.provisionedRetailerAccountId, input.auth.sub),
  });
  if (!application) throw new AppError(404, ErrorCode.NotFound, 'No application found for this account');
  const id = newId('amsg');
  await db.insert(applicationMessages).values({
    id,
    applicationId: application.id,
    authorKind: 'applicant',
    applicantEmail: application.ownerEmail,
    body: input.body.body,
    attachmentUrls: input.body.attachmentUrls ?? null,
  });
  return ok({ id });
}

export async function postPublicMessage(input: {
  id: string;
  body: z.infer<typeof PostMessageBody>;
}) {
  const application = await db.query.retailerApplications.findFirst({
    where: eq(retailerApplications.id, input.id),
  });
  if (!application || application.ownerEmail !== input.body.applicantEmail) {
    throw new AppError(404, ErrorCode.NotFound, 'Application not found');
  }
  const id = newId('amsg');
  await db.insert(applicationMessages).values({
    id,
    applicationId: application.id,
    authorKind: 'applicant',
    applicantEmail: input.body.applicantEmail,
    body: input.body.body,
    attachmentUrls: input.body.attachmentUrls ?? null,
  });
  return ok({ id });
}

/**
 * Submit the documents the admin requested while the application is docs_requested.
 * Upserts each doc by kind (keeps others), clears the satisfied kinds from
 * mustReuploadDocKinds, drops a thread note, and — once nothing remains outstanding —
 * flips the application back to `pending` for re-review.
 */
export async function submitClarificationDocuments(input: {
  id: string;
  body: z.infer<typeof SubmitDocumentsBody>;
}) {
  const application = await db.query.retailerApplications.findFirst({
    where: eq(retailerApplications.id, input.id),
  });
  if (!application || application.ownerEmail !== input.body.applicantEmail) {
    throw new AppError(404, ErrorCode.NotFound, 'Application not found');
  }
  if (application.status !== 'docs_requested') {
    throw new AppError(409, ErrorCode.InvalidState, 'No documents are being requested for this application');
  }

  const submittedKinds = new Set<string>(input.body.documents.map((d) => d.kind));
  const remaining = (application.mustReuploadDocKinds ?? []).filter((k) => !submittedKinds.has(k));
  const allSatisfied = remaining.length === 0;
  const kindList = input.body.documents.map((d) => d.kind).join(', ');

  await db.transaction(async (tx) => {
    // Upsert each submitted kind (replace matching kinds, keep the rest).
    await tx
      .delete(applicationDocuments)
      .where(
        and(
          eq(applicationDocuments.applicationId, application.id),
          inArray(applicationDocuments.kind, input.body.documents.map((d) => d.kind)),
        ),
      );
    await tx.insert(applicationDocuments).values(
      input.body.documents.map((d) => ({
        id: newId('adoc'),
        applicationId: application.id,
        kind: d.kind,
        url: d.url,
      })),
    );
    await tx.insert(applicationMessages).values({
      id: newId('amsg'),
      applicationId: application.id,
      authorKind: 'applicant',
      applicantEmail: input.body.applicantEmail,
      body: input.body.note?.trim()
        ? `${input.body.note.trim()}\n\nSubmitted documents: ${kindList}`
        : `Submitted requested documents: ${kindList}`,
      attachmentUrls: input.body.documents.map((d) => d.url),
    });
    await tx
      .update(retailerApplications)
      .set({
        mustReuploadDocKinds: remaining,
        // Back to the review queue once everything requested is in.
        ...(allSatisfied && { status: 'pending' }),
      })
      .where(eq(retailerApplications.id, application.id));
  });

  await notifyAllAdmins({
    kind: 'compliance',
    title: allSatisfied ? 'Requested documents submitted' : 'Some requested documents submitted',
    body: `${application.legalName} submitted: ${kindList}.`,
    deepLink: `/admin/applications/${application.id}`,
  }).catch(() => undefined);

  return ok({ status: allSatisfied ? 'pending' : 'docs_requested', remainingDocKinds: remaining });
}

export async function fetchForResubmit(input: {
  id: string;
  body: z.infer<typeof FetchForResubmitBody>;
}) {
  const application = await db.query.retailerApplications.findFirst({
    where: eq(retailerApplications.id, input.id),
  });
  if (!application || application.ownerEmail !== input.body.email) {
    throw new AppError(404, ErrorCode.NotFound, 'Application not found');
  }
  if (!application.passwordHash) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'This application has no stored password — contact support to resubmit',
    );
  }
  const ok_pw = await verifyPassword(input.body.password, application.passwordHash);
  if (!ok_pw) {
    throw new AppError(401, ErrorCode.InvalidCredentials, 'Incorrect password');
  }
  if (application.status !== 'rejected') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'Re-application only available after the original was rejected',
    );
  }
  const documents = await db.query.applicationDocuments.findMany({
    where: eq(applicationDocuments.applicationId, application.id),
  });
  const { passwordHash: _ph, ...safe } = application;
  void _ph;
  return ok({
    application: safe,
    documents: documents.map((d) => ({ kind: d.kind, url: d.url })),
  });
}

export async function resubmitApplication(input: {
  id: string;
  body: z.infer<typeof ResubmitBody>;
  requestId: string;
}) {
  const { id, body, requestId } = input;
  const application = await db.query.retailerApplications.findFirst({
    where: eq(retailerApplications.id, id),
  });
  if (!application || application.ownerEmail !== body.email) {
    throw new AppError(404, ErrorCode.NotFound, 'Application not found');
  }
  if (!application.passwordHash) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'This application has no stored password — contact support to resubmit',
    );
  }
  const ok_pw = await verifyPassword(body.password, application.passwordHash);
  if (!ok_pw) {
    throw new AppError(401, ErrorCode.InvalidCredentials, 'Incorrect password');
  }
  if (application.status !== 'rejected') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'Re-application only available after the original was rejected',
    );
  }

  // Build the new documents map keyed by kind for fast lookup.
  const newDocByKind = new Map<string, string>();
  for (const d of body.documents ?? []) {
    newDocByKind.set(d.kind, d.url);
  }

  // Validate must-reupload constraint
  if ((application.mustReuploadDocKinds ?? []).length > 0) {
    const prior = await db.query.applicationDocuments.findMany({
      where: eq(applicationDocuments.applicationId, application.id),
    });
    const priorByKind = new Map<string, string>(
      prior.map((d) => [d.kind, d.url] as const),
    );
    for (const kind of application.mustReuploadDocKinds) {
      const newUrl = newDocByKind.get(kind);
      if (!newUrl) {
        throw new AppError(
          422,
          ErrorCode.ValidationError,
          `Admin asked you to replace the document for "${kind}" — please upload a new file`,
        );
      }
      if (newUrl === priorByKind.get(kind)) {
        throw new AppError(
          422,
          ErrorCode.ValidationError,
          `Document for "${kind}" must be re-uploaded, not the same file`,
        );
      }
    }
  }

  const priorDecisionReason = application.decisionReason;
  const priorDecidedBy = application.decidedByAccountId;

  // Refresh legal consent to the versions current at RESUBMIT time (if given).
  const consent = body.acceptLegal
    ? {
        legalConsentAt: new Date(),
        consentTermsVersion: (await currentLegalDoc(db, 'terms')).version,
        consentPrivacyVersion: (await currentLegalDoc(db, 'privacy')).version,
      }
    : {};

  await db.transaction(async (tx) => {
    // Archive the rejection into the message thread.
    if (priorDecisionReason) {
      await tx.insert(applicationMessages).values({
        id: newId('amsg'),
        applicationId: application.id,
        authorKind: 'admin',
        authorAccountId: priorDecidedBy ?? null,
        body: `Previous rejection: ${priorDecisionReason}`,
      });
    }
    await tx.insert(applicationMessages).values({
      id: newId('amsg'),
      applicationId: application.id,
      authorKind: 'applicant',
      applicantEmail: body.email,
      body: 'Application resubmitted with updated details.',
    });

    // Replace the document set wholesale.
    await tx
      .delete(applicationDocuments)
      .where(eq(applicationDocuments.applicationId, application.id));
    if (body.documents?.length) {
      await tx.insert(applicationDocuments).values(
        body.documents.map((d) => ({
          id: newId('adoc'),
          applicationId: application.id,
          kind: d.kind,
          url: d.url,
        })),
      );
    }

    // Update editable fields, reset decision metadata, bump counter.
    await tx
      .update(retailerApplications)
      .set({
        ...consent,
        legalName: body.legalName,
        storeName: body.storeName ?? null,
        gstin: body.gstin,
        pan: body.pan ?? null,
        ownerName: body.ownerName,
        // ownerEmail intentionally not changed — identity anchor for the row.
        ownerPhone: body.ownerPhone,
        addressLine: body.addressLine,
        pincode: body.pincode,
        stateCode: body.stateCode,
        lat: body.lat ?? null,
        lng: body.lng ?? null,
        hours: body.hours ?? null,
        categories: body.categories ?? null,
        brands: body.brands ?? null,
        sampleSkus: body.sampleSkus ?? null,
        contactPhone: body.contactPhone ?? null,
        managerName: body.managerName ?? null,
        bankLegalName: body.bankLegalName ?? null,
        bankAccountNumber: body.bankAccountNumber ?? null,
        bankIfsc: body.bankIfsc ?? null,
        status: 'pending',
        decidedAt: null,
        decidedByAccountId: null,
        decisionReason: null,
        mustReuploadDocKinds: [],
        resubmissionCount: application.resubmissionCount + 1,
        submittedAt: new Date(),
      })
      .where(eq(retailerApplications.id, application.id));
  });

  await recordAudit({
    actor: { sub: body.email, kind: 'retailer' },
    action: 'application.resubmitted',
    resourceKind: 'retailer_application',
    resourceId: application.id,
    after: { resubmissionCount: application.resubmissionCount + 1 },
    requestId,
  });

  return ok({ id: application.id, status: 'pending', message: 'Application resubmitted' });
}
