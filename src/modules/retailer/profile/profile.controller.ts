/**
 * Retailer profile: /me snapshot + store create + store profile patch.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  changeRequests,
  retailerAccounts,
  retailerStores,
  retailerTermsAcceptances,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import {
  currentLegalDoc,
  hasAcceptedCurrentLegalDoc,
  LEGAL_DOC_LABELS,
  type LegalDocKind,
} from '@/shared/terms.js';
import type {
  CreateStoreBody,
  PatchProfileBody,
} from './profile.validators.js';

type Auth = AccessTokenPayload;

async function loadRetailer(retailerId: string) {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
  });
  if (!retailer) throw AppError.unauthorized('Retailer account no longer exists');
  return retailer;
}

export async function getMe(input: { auth: Auth }) {
  const retailer = await loadRetailer(input.auth.sub);
  const store = retailer.storeId
    ? await db.query.retailerStores.findFirst({ where: eq(retailerStores.id, retailer.storeId) })
    : null;
  // Legal acceptance is INDEPENDENT of the store lifecycle: any store that hasn't
  // accepted the current version of a document is `pending`, whatever its status.
  // A version bump therefore re-flags every store until it re-accepts. Same rule
  // for both documents (T&C and Privacy Policy).
  const termsAccepted = store ? await hasAcceptedCurrentLegalDoc(db, store.id, 'terms') : true;
  const termsAcceptanceRequired = store ? !termsAccepted : false;
  const ct = await currentLegalDoc(db, 'terms');
  const privacyAccepted = store ? await hasAcceptedCurrentLegalDoc(db, store.id, 'privacy') : true;
  const privacyAcceptanceRequired = store ? !privacyAccepted : false;
  const cp = await currentLegalDoc(db, 'privacy');

  // Surface any in-flight account-lifecycle request so the app can show
  // "closure pending" / "reopen pending" instead of a stale action button.
  const pendingLifecycle = store
    ? await db.query.changeRequests.findFirst({
        where: and(
          eq(changeRequests.storeId, store.id),
          eq(changeRequests.status, 'pending'),
          inArray(changeRequests.field, ['account_deletion', 'account_reopen']),
        ),
        orderBy: desc(changeRequests.submittedAt),
        columns: { field: true },
      })
    : null;
  const pendingAccountRequest =
    (pendingLifecycle?.field as 'account_deletion' | 'account_reopen' | undefined) ?? null;

  return ok({
    termsAcceptanceRequired,
    privacyAcceptanceRequired,
    pendingAccountRequest,
    termsStatus: (store ? (termsAccepted ? 'accepted' : 'pending') : 'accepted') as
      | 'accepted'
      | 'pending',
    privacyStatus: (store ? (privacyAccepted ? 'accepted' : 'pending') : 'accepted') as
      | 'accepted'
      | 'pending',
    currentTermsVersion: ct.version,
    currentPrivacyVersion: cp.version,
    retailer: {
      id: retailer.id,
      email: retailer.email,
      legalName: retailer.legalName,
      phone: retailer.phone,
      gstin: retailer.gstin,
      status: retailer.status,
      suspendReason: retailer.suspendReason,
    },
    store: store
      ? {
          id: store.id,
          legalName: store.legalName,
          gstin: store.gstin,
          gstScheme: store.gstScheme,
          address: store.address,
          stateCode: store.stateCode,
          lat: store.lat,
          lng: store.lng,
          status: store.status,
          platformFeeBp: store.platformFeeBp,
          payoutCadenceDays: store.payoutCadenceDays,
          posBillingEnabled: store.posBillingEnabled,
          // Retailer self-serve online/offline toggle. `orderPauseUntil` in the
          // future = offline (auto-reopens at that instant); null/past = online.
          orderPauseUntil:
            store.orderPauseUntil && store.orderPauseUntil > new Date()
              ? store.orderPauseUntil.toISOString()
              : null,
          suspendReason: store.suspendReason,
          pauseReason: store.pauseReason,
          contactPhone: store.contactPhone ?? null,
          managerName: store.managerName ?? null,
          galleryImageUrls: store.galleryImageUrls ?? [],
        }
      : null,
  });
}

export async function createStore(input: { auth: Auth; body: z.infer<typeof CreateStoreBody> }) {
  const retailer = await loadRetailer(input.auth.sub);

  if (retailer.storeId) {
    throw new AppError(
      409,
      ErrorCode.StoreAlreadyExists,
      'This account already owns a store — only one store per retailer in MVP',
    );
  }

  const id = newId(IdPrefix.Store);
  const body = input.body;

  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(retailerStores)
      .values({
        id,
        legalEntityId: retailer.id,
        legalName: body.legalName,
        gstin: retailer.gstin,
        address: body.address,
        stateCode: body.stateCode,
        lat: body.lat,
        lng: body.lng,
        ...(body.openingHours !== undefined && { openingHours: body.openingHours }),
        // Independent store contact — default to the owner's phone when not supplied.
        contactPhone: body.contactPhone ?? retailer.phone,
        ...(body.managerName !== undefined && { managerName: body.managerName }),
        status: 'onboarding',
        platformFeeBp: 0,
        payoutCadenceDays: 0,
      })
      .returning();
    if (!row) throw AppError.internal('store insert returned no row');

    await tx
      .update(retailerAccounts)
      .set({ storeId: id })
      .where(eq(retailerAccounts.id, retailer.id));

    return row;
  });

  return ok({
    id: created.id,
    legalName: created.legalName,
    gstin: created.gstin,
    address: created.address,
    stateCode: created.stateCode,
    lat: created.lat,
    lng: created.lng,
    status: created.status,
    platformFeeBp: created.platformFeeBp,
    payoutCadenceDays: created.payoutCadenceDays,
  });
}

export async function patchStoreProfile(input: {
  auth: Auth;
  body: z.infer<typeof PatchProfileBody>;
}) {
  const retailer = await loadRetailer(input.auth.sub);
  if (!retailer.storeId) {
    throw new AppError(404, ErrorCode.NotFound, 'No store found for this account');
  }
  const patch: Partial<typeof retailerStores.$inferInsert> = {};
  if (input.body.contactPhone !== undefined) patch.contactPhone = input.body.contactPhone ?? null;
  if (input.body.managerName !== undefined) patch.managerName = input.body.managerName ?? null;
  if (input.body.galleryImageUrls !== undefined) {
    patch.galleryImageUrls = input.body.galleryImageUrls ?? null;
  }
  if (input.body.gstScheme !== undefined) patch.gstScheme = input.body.gstScheme;
  if (Object.keys(patch).length === 0) {
    throw new AppError(400, ErrorCode.ValidationError, 'No fields to update');
  }
  await db.update(retailerStores).set(patch).where(eq(retailerStores.id, retailer.storeId));
  return ok({ success: true });
}

// Account closure is no longer a destructive single-click delete. The owner/manager
// files an `account_deletion` change request (POST /retailer/account/close-request),
// an admin approves it, and the store is SUSPENDED + accounts marked `closed` —
// reversibly, records intact — so the retailer can later reopen. See
// modules/retailer/compliance and modules/admin/compliance.

/** Current Retailer T&C (current admin version + short text) + whether this store accepted it. */
export async function getTerms(input: { auth: Auth; kind?: LegalDocKind }) {
  const kind: LegalDocKind = input.kind ?? 'terms';
  const retailer = await loadRetailer(input.auth.sub);
  const ct = await currentLegalDoc(db, kind);
  let acceptedAt: Date | null = null;
  if (retailer.storeId) {
    const row = await db.query.retailerTermsAcceptances.findFirst({
      where: and(
        eq(retailerTermsAcceptances.storeId, retailer.storeId),
        eq(retailerTermsAcceptances.docKind, kind),
        eq(retailerTermsAcceptances.termsVersion, ct.version),
        eq(retailerTermsAcceptances.decision, 'accepted'),
      ),
      columns: { acceptedAt: true },
    });
    acceptedAt = row?.acceptedAt ?? null;
  }
  return ok({
    version: ct.version,
    label: ct.label,
    shortText: ct.shortText,
    acceptedAt: acceptedAt ? acceptedAt.toISOString() : null,
  });
}

/** Record a decision (accept/decline) on the current version of one legal document (audited with IP + UA). */
async function recordTermsDecision(
  auth: Auth,
  kind: LegalDocKind,
  version: string,
  decision: 'accepted' | 'declined',
  ip: string | null,
  userAgent: string | null,
) {
  const retailer = await loadRetailer(auth.sub);
  if (!retailer.storeId) {
    throw new AppError(404, ErrorCode.NotFound, 'No store found for this account');
  }
  const ct = await currentLegalDoc(db, kind);
  if (version !== ct.version) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `The ${LEGAL_DOC_LABELS[kind]} has changed — reload and review the current version.`,
    );
  }
  await db
    .insert(retailerTermsAcceptances)
    .values({
      id: newId(IdPrefix.TermsAcceptance),
      storeId: retailer.storeId,
      acceptedByAccountId: retailer.id,
      docKind: kind,
      termsVersion: ct.version,
      decision,
      ipAddress: ip,
      userAgent,
    })
    // Only ACCEPTS are constrained one-per-(store,version); declines append freely.
    .onConflictDoNothing();
  return ct.version;
}

export async function acceptTerms(input: {
  auth: Auth;
  body: { version: string };
  ip: string | null;
  userAgent: string | null;
  kind?: LegalDocKind;
}) {
  const version = await recordTermsDecision(
    input.auth,
    input.kind ?? 'terms',
    input.body.version,
    'accepted',
    input.ip,
    input.userAgent,
  );
  return ok({ version, decision: 'accepted' });
}

/** Retailer declines the document — recorded for audit. The client then logs the user out. */
export async function declineTerms(input: {
  auth: Auth;
  body: { version: string };
  ip: string | null;
  userAgent: string | null;
  kind?: LegalDocKind;
}) {
  const version = await recordTermsDecision(
    input.auth,
    input.kind ?? 'terms',
    input.body.version,
    'declined',
    input.ip,
    input.userAgent,
  );
  return ok({ version, decision: 'declined' });
}
