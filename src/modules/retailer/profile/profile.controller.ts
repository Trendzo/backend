/**
 * Retailer profile: /me snapshot + store create + store profile patch.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  aiCatalogSubmissions,
  productListings,
  retailerAccounts,
  retailerStores,
  retailerTermsAcceptances,
  storeMedia,
  variants,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { hashPassword } from '@/shared/auth/password.js';
import { recordAudit } from '@/shared/audit.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import { currentTerms, hasAcceptedCurrentTerms } from '@/shared/terms.js';
import type {
  CreateStoreBody,
  DeleteAccountBody,
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
  // Terms acceptance is INDEPENDENT of the store lifecycle: any store that hasn't
  // accepted the current terms version is `pending`, whatever its status. A version
  // bump therefore re-flags every store until it re-accepts.
  const termsAccepted = store ? await hasAcceptedCurrentTerms(db, store.id) : true;
  const termsAcceptanceRequired = store ? !termsAccepted : false;
  const ct = await currentTerms(db);
  return ok({
    termsAcceptanceRequired,
    termsStatus: (store ? (termsAccepted ? 'accepted' : 'pending') : 'accepted') as
      | 'accepted'
      | 'pending',
    currentTermsVersion: ct.version,
    retailer: {
      id: retailer.id,
      email: retailer.email,
      legalName: retailer.legalName,
      phone: retailer.phone,
      gstin: retailer.gstin,
      status: retailer.status,
      permanentSuspend: retailer.permanentSuspend,
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
          permanentSuspend: store.permanentSuspend,
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

/**
 * Close the retailer business account immediately. Commerce/tax records remain
 * available to the operator only where legally required, while credentials and
 * customer-facing/profile media are revoked or anonymized.
 */
export async function deleteAccount(input: {
  auth: Auth;
  body: z.infer<typeof DeleteAccountBody>;
  requestId?: string;
}) {
  const retailer = await loadRetailer(input.auth.sub);
  if (retailer.subRole !== 'owner' || input.auth.subRole !== 'owner') {
    throw AppError.forbidden('Only the store owner can delete the business account');
  }

  const now = new Date();
  const storeId = retailer.storeId;
  const accounts = storeId
    ? await db.query.retailerAccounts.findMany({ where: eq(retailerAccounts.storeId, storeId) })
    : [retailer];
  const revoked = await Promise.all(
    accounts.map(async (account) => ({
      id: account.id,
      passwordHash: await hashPassword(randomUUID()),
    })),
  );

  await db.transaction(async (tx) => {
    for (const account of revoked) {
      await tx
        .update(retailerAccounts)
        .set({
          email: `deleted+${account.id}@deleted.invalid`,
          phone: '',
          legalName: 'Deleted account',
          passwordHash: account.passwordHash,
          status: 'terminated',
          permanentSuspend: true,
          suspendReason: 'account_deleted_by_user',
          suspendedAt: now,
          suspendedByAccountId: input.auth.sub,
        })
        .where(eq(retailerAccounts.id, account.id));
    }

    if (storeId) {
      await tx
        .update(retailerStores)
        .set({
          contactPhone: null,
          managerName: null,
          galleryImageUrls: [],
          status: 'terminated',
          permanentSuspend: true,
          suspendReason: 'account_deleted_by_user',
          suspendedAt: now,
          suspendedByAccountId: input.auth.sub,
        })
        .where(eq(retailerStores.id, storeId));
      await tx
        .update(productListings)
        .set({ status: 'retired', galleryUrls: [], updatedAt: now })
        .where(eq(productListings.storeId, storeId));
      await tx
        .update(variants)
        .set({ isActive: false, imageUrls: [] })
        .where(eq(variants.storeId, storeId));
      await tx.update(storeMedia).set({ deletedAt: now }).where(eq(storeMedia.storeId, storeId));
      await tx
        .update(aiCatalogSubmissions)
        .set({
          prompt: '[deleted]',
          referenceImageUrls: [],
          rawPhotos: [],
          outputUrls: [],
          revisionNotes: null,
          thirdPartyRequestId: null,
        })
        .where(eq(aiCatalogSubmissions.storeId, storeId));
    }
  });

  // Deletion is already complete at this point. A secondary audit failure must
  // not turn the response into an error and prompt an impossible retry.
  await recordAudit({
    actor: input.auth,
    action: 'retailer.account_delete',
    resourceKind: 'retailer_account',
    resourceId: retailer.id,
    before: { storeId, status: retailer.status },
    after: { status: 'terminated', personalDataAnonymized: true },
    ...(input.requestId !== undefined && { requestId: input.requestId }),
    note: 'Deletion initiated in the iOS app by the retailer owner',
  }).catch(() => undefined);

  return ok({
    deleted: true,
    deletedAt: now.toISOString(),
    retainedForLegalCompliance: [
      'GST and tax records',
      'orders and invoices',
      'payout and accounting records',
      'fraud-prevention and audit records',
    ],
  });
}

/** Current Retailer T&C (current admin version + short text) + whether this store accepted it. */
export async function getTerms(input: { auth: Auth }) {
  const retailer = await loadRetailer(input.auth.sub);
  const ct = await currentTerms(db);
  let acceptedAt: Date | null = null;
  if (retailer.storeId) {
    const row = await db.query.retailerTermsAcceptances.findFirst({
      where: and(
        eq(retailerTermsAcceptances.storeId, retailer.storeId),
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

/** Record a decision (accept/decline) on the current terms for this store (audited with IP + UA). */
async function recordTermsDecision(
  auth: Auth,
  version: string,
  decision: 'accepted' | 'declined',
  ip: string | null,
  userAgent: string | null,
) {
  const retailer = await loadRetailer(auth.sub);
  if (!retailer.storeId) {
    throw new AppError(404, ErrorCode.NotFound, 'No store found for this account');
  }
  const ct = await currentTerms(db);
  if (version !== ct.version) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'Terms have changed — reload and review the current version.',
    );
  }
  await db
    .insert(retailerTermsAcceptances)
    .values({
      id: newId(IdPrefix.TermsAcceptance),
      storeId: retailer.storeId,
      acceptedByAccountId: retailer.id,
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
}) {
  const version = await recordTermsDecision(input.auth, input.body.version, 'accepted', input.ip, input.userAgent);
  return ok({ version, decision: 'accepted' });
}

/** Retailer declines the terms — recorded for audit. The client then logs the user out. */
export async function declineTerms(input: {
  auth: Auth;
  body: { version: string };
  ip: string | null;
  userAgent: string | null;
}) {
  const version = await recordTermsDecision(input.auth, input.body.version, 'declined', input.ip, input.userAgent);
  return ok({ version, decision: 'declined' });
}
