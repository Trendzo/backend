/**
 * Retailer profile: /me snapshot + store create + store profile patch.
 */
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { retailerAccounts, retailerStores } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type { CreateStoreBody, PatchProfileBody } from './profile.validators.js';

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
  return ok({
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
          address: store.address,
          stateCode: store.stateCode,
          lat: store.lat,
          lng: store.lng,
          status: store.status,
          platformFeeBp: store.platformFeeBp,
          payoutCadenceDays: store.payoutCadenceDays,
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
        ...(body.contactPhone !== undefined && { contactPhone: body.contactPhone }),
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
  if (Object.keys(patch).length === 0) {
    throw new AppError(400, ErrorCode.ValidationError, 'No fields to update');
  }
  await db.update(retailerStores).set(patch).where(eq(retailerStores.id, retailer.storeId));
  return ok({ success: true });
}
