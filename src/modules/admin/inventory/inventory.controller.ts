import { and, desc, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  inventoryAdjustments,
  inventoryReservations,
  variants,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { newId } from '@/shared/ids.js';
import { recordAudit } from '@/shared/audit.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  CreateAdjustmentBody,
  ListAdjustmentsQuery,
  ListReservationsQuery,
} from './inventory.validators.js';

type Auth = AccessTokenPayload;

export async function listAdjustments(input: {
  query: z.infer<typeof ListAdjustmentsQuery>;
}) {
  const { variantId, reason, limit } = input.query;
  const conditions = [];
  if (variantId) conditions.push(eq(inventoryAdjustments.variantId, variantId));
  if (reason) conditions.push(eq(inventoryAdjustments.reason, reason));

  const rows = await db.query.inventoryAdjustments.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy: desc(inventoryAdjustments.at),
    limit,
  });
  return ok(rows);
}

export async function createAdjustment(input: {
  auth: Auth;
  body: z.infer<typeof CreateAdjustmentBody>;
  requestId: string;
}) {
  const { auth, body, requestId } = input;
  const variant = await db.query.variants.findFirst({
    where: eq(variants.id, body.variantId),
  });
  if (!variant) throw new AppError(404, ErrorCode.NotFound, 'Variant not found');

  const newStock = variant.stock + body.delta;
  if (newStock < 0) {
    throw new AppError(409, ErrorCode.InvalidState, 'Adjustment would make stock negative');
  }

  await db.update(variants).set({ stock: newStock }).where(eq(variants.id, variant.id));

  const id = newId('inv');
  await db.insert(inventoryAdjustments).values({
    id,
    variantId: variant.id,
    delta: body.delta,
    newStock,
    reason: body.reason,
    actorKind: 'admin',
    actorId: auth.sub,
    refKind: body.refKind ?? null,
    refId: body.refId ?? null,
    note: body.note ?? null,
  });

  await recordAudit({
    actor: auth,
    action: 'inventory.adjust',
    resourceKind: 'variant',
    resourceId: variant.id,
    before: { stock: variant.stock },
    after: { stock: newStock },
    requestId,
  });

  return ok({ id, variantId: variant.id, newStock });
}

export async function listReservations(input: {
  query: z.infer<typeof ListReservationsQuery>;
}) {
  const { variantId, ownerKind, active, limit } = input.query;
  const conditions = [];
  if (variantId) conditions.push(eq(inventoryReservations.variantId, variantId));
  if (ownerKind) conditions.push(eq(inventoryReservations.ownerKind, ownerKind));
  if (active === true) {
    conditions.push(isNull(inventoryReservations.releasedAt));
  }
  const rows = await db.query.inventoryReservations.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy: desc(inventoryReservations.reservedAt),
    limit,
  });
  return ok(rows);
}
