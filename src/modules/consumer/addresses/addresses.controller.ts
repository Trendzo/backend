/**
 * Consumer address book. Scoped to the authenticated consumer; every read/write asserts
 * ownership. The `is_default` flag is enforced by a partial unique index on
 * (consumer_id) WHERE is_default = true, so promote-to-default must run inside a
 * transaction that first clears the prior default.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { addresses, orders } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  AddressBodySchema,
  PartialAddressBodySchema,
} from './addresses.validators.js';

type Auth = AccessTokenPayload;
type AddressBody = z.infer<typeof AddressBodySchema>;

function rowOut(r: typeof addresses.$inferSelect) {
  return {
    id: r.id,
    label: r.label,
    line1: r.line1,
    line2: r.line2,
    city: r.city,
    pincode: r.pincode,
    stateCode: r.stateCode,
    lat: r.lat,
    lng: r.lng,
    isDefault: r.isDefault,
    createdAt: r.createdAt,
  };
}

/** Promote `addressId` to the consumer's default in one transaction. */
async function promoteToDefault(consumerId: string, addressId: string) {
  await db.transaction(async (tx) => {
    await tx
      .update(addresses)
      .set({ isDefault: false })
      .where(and(eq(addresses.consumerId, consumerId), eq(addresses.isDefault, true)));
    await tx.update(addresses).set({ isDefault: true }).where(eq(addresses.id, addressId));
  });
}

export async function listAddresses(input: { auth: Auth }) {
  const rows = await db.query.addresses.findMany({
    where: eq(addresses.consumerId, input.auth.sub),
    orderBy: [desc(addresses.isDefault), desc(addresses.createdAt)],
  });
  return ok(rows.map(rowOut));
}

export async function createAddress(input: { auth: Auth; body: AddressBody }) {
  const { auth, body } = input;
  const existing = await db
    .select({ id: addresses.id })
    .from(addresses)
    .where(eq(addresses.consumerId, auth.sub))
    .limit(1);
  const isFirstAddress = existing.length === 0;
  const shouldBeDefault = isFirstAddress || body.isDefault === true;

  const id = newId(IdPrefix.Address);

  await db.transaction(async (tx) => {
    if (shouldBeDefault) {
      await tx
        .update(addresses)
        .set({ isDefault: false })
        .where(and(eq(addresses.consumerId, auth.sub), eq(addresses.isDefault, true)));
    }
    await tx.insert(addresses).values({
      id,
      consumerId: auth.sub,
      label: body.label ?? null,
      line1: body.line1,
      line2: body.line2 ?? null,
      city: body.city,
      pincode: body.pincode,
      stateCode: body.stateCode.toUpperCase(),
      lat: body.lat,
      lng: body.lng,
      isDefault: shouldBeDefault,
    });
  });

  const created = await db.query.addresses.findFirst({ where: eq(addresses.id, id) });
  return ok(rowOut(created!));
}

export async function patchAddress(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof PartialAddressBodySchema>;
}) {
  const { auth, id, body } = input;

  const existing = await db.query.addresses.findFirst({
    where: and(eq(addresses.id, id), eq(addresses.consumerId, auth.sub)),
  });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Address not found');

  const updates: Partial<typeof addresses.$inferInsert> = {};
  if (body.label !== undefined) updates.label = body.label ?? null;
  if (body.line1 !== undefined) updates.line1 = body.line1;
  if (body.line2 !== undefined) updates.line2 = body.line2 ?? null;
  if (body.city !== undefined) updates.city = body.city;
  if (body.pincode !== undefined) updates.pincode = body.pincode;
  if (body.stateCode !== undefined) updates.stateCode = body.stateCode.toUpperCase();
  if (body.lat !== undefined) updates.lat = body.lat;
  if (body.lng !== undefined) updates.lng = body.lng;

  if (Object.keys(updates).length > 0) {
    await db.update(addresses).set(updates).where(eq(addresses.id, id));
  }
  if (body.isDefault === true && !existing.isDefault) {
    await promoteToDefault(auth.sub, id);
  }

  const updated = await db.query.addresses.findFirst({ where: eq(addresses.id, id) });
  return ok(rowOut(updated!));
}

export async function deleteAddress(input: { auth: Auth; id: string }) {
  const { auth, id } = input;

  const existing = await db.query.addresses.findFirst({
    where: and(eq(addresses.id, id), eq(addresses.consumerId, auth.sub)),
  });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Address not found');

  // Refuse delete if any live order still references this address.
  const referenced = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(eq(orders.addressId, id), sql`${orders.status} NOT IN ('cancelled','closed')`),
    )
    .limit(1);
  if (referenced.length > 0) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'Address is in use by an active order; cancel or close it before deleting',
    );
  }

  await db.transaction(async (tx) => {
    await tx.delete(addresses).where(eq(addresses.id, id));
    if (existing.isDefault) {
      // Promote the most recent remaining address as the new default.
      const next = await tx.query.addresses.findFirst({
        where: eq(addresses.consumerId, auth.sub),
        orderBy: desc(addresses.createdAt),
      });
      if (next) {
        await tx
          .update(addresses)
          .set({ isDefault: true })
          .where(eq(addresses.id, next.id));
      }
    }
  });
  return ok({ id, deleted: true });
}

export async function setDefaultAddress(input: { auth: Auth; id: string }) {
  const { auth, id } = input;

  const existing = await db.query.addresses.findFirst({
    where: and(eq(addresses.id, id), eq(addresses.consumerId, auth.sub)),
  });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Address not found');

  if (!existing.isDefault) {
    await promoteToDefault(auth.sub, id);
  }
  const updated = await db.query.addresses.findFirst({ where: eq(addresses.id, id) });
  return ok(rowOut(updated!));
}
