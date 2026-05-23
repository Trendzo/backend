/**
 * Admin per-store promotions + vouchers + pickup-slots.
 */
import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  promotions,
  retailerAccounts,
  retailerStores,
  storePickupSlots,
  voucherCodes,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { recordAudit } from '@/shared/audit.js';
import { notify, notifySummaryToStoreOwners } from '@/shared/notify.js';
import { generateCodes } from '@/shared/promotions/voucher-codes.js';
import {
  defaultAppliedTo,
  validateConfigForDiscountType,
} from '@/shared/promotions/schemas.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  BulkPauseBody,
  CreatePromotionBody,
  ListPromotionsQuery,
  PatchPromotionBody,
  VoucherGenerateBody,
} from './store-promotions.validators.js';

type Auth = AccessTokenPayload;

async function loadStoreOr404(storeId: string) {
  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, storeId),
  });
  if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  return store;
}

async function notifyOwners(
  storeId: string,
  payload: { title: string; body?: string; deepLink?: string },
): Promise<void> {
  const owners = await db.query.retailerAccounts.findMany({
    where: eq(retailerAccounts.storeId, storeId),
  });
  await Promise.all(
    owners.map((o) =>
      notify({
        recipientKind: 'retailer',
        recipientId: o.id,
        kind: 'system',
        title: payload.title,
        body: payload.body ?? null,
        deepLink: payload.deepLink ?? null,
      }),
    ),
  );
}

export async function listPromotions(input: {
  storeId: string;
  query: z.infer<typeof ListPromotionsQuery>;
}) {
  const conds: SQL[] = [eq(promotions.storeId, input.storeId)];
  if (input.query.status) conds.push(eq(promotions.status, input.query.status));
  if (input.query.mechanism) conds.push(eq(promotions.mechanism, input.query.mechanism));
  const rows = await db.query.promotions.findMany({
    where: and(...conds),
    orderBy: desc(promotions.validFrom),
  });
  return ok(rows);
}

export async function getPromotion(input: { storeId: string; id: string }) {
  const promo = await db.query.promotions.findFirst({
    where: and(eq(promotions.id, input.id), eq(promotions.storeId, input.storeId)),
  });
  if (!promo) throw new AppError(404, ErrorCode.NotFound, 'Promotion not found');
  return ok(promo);
}

export async function createPromotion(input: {
  auth: Auth;
  storeId: string;
  body: z.infer<typeof CreatePromotionBody>;
  requestId: string;
}) {
  let validatedConfig;
  try {
    validatedConfig = validateConfigForDiscountType(input.body.discountType, input.body.config);
  } catch (e) {
    throw new AppError(
      422,
      ErrorCode.ValidationError,
      `Invalid config for discountType '${input.body.discountType}'`,
      (e as { issues?: unknown }).issues ?? String(e),
    );
  }
  if (input.body.validUntil.getTime() <= input.body.validFrom.getTime()) {
    throw new AppError(422, ErrorCode.ValidationError, 'validUntil must be strictly after validFrom');
  }
  const appliedTo =
    input.body.appliedTo ??
    defaultAppliedTo(input.body.mechanism, 'admin', input.body.discountType);
  const id = newId(IdPrefix.Promotion);
  const [created] = await db
    .insert(promotions)
    .values({
      id,
      storeId: input.storeId,
      name: input.body.name,
      mechanism: input.body.mechanism,
      discountType: input.body.discountType,
      issuerType: 'admin',
      appliedTo,
      scope: (input.body.scope ?? {}) as Record<string, unknown>,
      config: validatedConfig as unknown as Record<string, unknown>,
      stackableWith: input.body.stackableWith,
      nonStackable: input.body.nonStackable,
      ...(input.body.totalUses !== undefined &&
        input.body.totalUses !== null && { totalUses: input.body.totalUses }),
      ...(input.body.perConsumerLimit !== undefined &&
        input.body.perConsumerLimit !== null && { perConsumerLimit: input.body.perConsumerLimit }),
      validFrom: input.body.validFrom,
      validUntil: input.body.validUntil,
      status: input.body.status ?? 'draft',
    })
    .returning();
  await recordAudit({
    actor: input.auth,
    action: 'promotion.create',
    resourceKind: 'promotion',
    resourceId: id,
    after: { name: input.body.name, mechanism: input.body.mechanism },
    impersonatedStoreId: input.storeId,
    requestId: input.requestId,
  });
  await notifyOwners(input.storeId, {
    title: 'Admin created a promotion',
    body: input.body.name,
    deepLink: `/retailer/promotions/${id}`,
  });
  return ok(created);
}

export async function patchPromotion(input: {
  auth: Auth;
  storeId: string;
  id: string;
  body: z.infer<typeof PatchPromotionBody>;
  requestId: string;
}) {
  const existing = await db.query.promotions.findFirst({
    where: and(eq(promotions.id, input.id), eq(promotions.storeId, input.storeId)),
  });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Promotion not found');
  const patch: Record<string, unknown> = {};
  if (input.body.name !== undefined) patch.name = input.body.name;
  if (input.body.validFrom !== undefined) patch.validFrom = input.body.validFrom;
  if (input.body.validUntil !== undefined) patch.validUntil = input.body.validUntil;
  if (input.body.totalUses !== undefined) patch.totalUses = input.body.totalUses;
  if (input.body.perConsumerLimit !== undefined) patch.perConsumerLimit = input.body.perConsumerLimit;
  if (input.body.stackableWith !== undefined) patch.stackableWith = input.body.stackableWith;
  if (input.body.nonStackable !== undefined) patch.nonStackable = input.body.nonStackable;
  const [updated] = await db
    .update(promotions)
    .set(patch)
    .where(eq(promotions.id, existing.id))
    .returning();
  await recordAudit({
    actor: input.auth,
    action: 'promotion.update',
    resourceKind: 'promotion',
    resourceId: existing.id,
    before: { name: existing.name },
    after: patch,
    impersonatedStoreId: input.storeId,
    requestId: input.requestId,
  });
  return ok(updated);
}

async function setPromoStatus(
  storeId: string,
  promoId: string,
  targetStatus: 'active' | 'paused' | 'revoked',
): Promise<typeof promotions.$inferSelect> {
  const existing = await db.query.promotions.findFirst({
    where: and(eq(promotions.id, promoId), eq(promotions.storeId, storeId)),
  });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Promotion not found');
  const [updated] = await db
    .update(promotions)
    .set({ status: targetStatus })
    .where(eq(promotions.id, existing.id))
    .returning();
  return updated!;
}

export async function setStatus(input: {
  auth: Auth;
  storeId: string;
  id: string;
  verb: 'pause' | 'resume' | 'revoke' | 'activate';
  requestId: string;
}) {
  const next =
    input.verb === 'pause' ? 'paused' : input.verb === 'revoke' ? 'revoked' : 'active';
  const updated = await setPromoStatus(input.storeId, input.id, next);
  await recordAudit({
    actor: input.auth,
    action: `promotion.${input.verb}`,
    resourceKind: 'promotion',
    resourceId: input.id,
    after: { status: next },
    impersonatedStoreId: input.storeId,
    requestId: input.requestId,
  });
  await notifyOwners(input.storeId, {
    title: `Admin ${input.verb}d a promotion`,
    deepLink: `/retailer/promotions/${input.id}`,
  });
  return ok(updated);
}

export async function bulkPause(input: {
  auth: Auth;
  storeId: string;
  body: z.infer<typeof BulkPauseBody>;
  requestId: string;
}) {
  let paused = 0;
  const pausedIds: string[] = [];
  for (const id of input.body.promotionIds) {
    const existing = await db.query.promotions.findFirst({
      where: and(eq(promotions.id, id), eq(promotions.storeId, input.storeId)),
    });
    if (!existing || existing.status !== 'active') continue;
    await db.update(promotions).set({ status: 'paused' }).where(eq(promotions.id, existing.id));
    await recordAudit({
      actor: input.auth,
      action: 'promotion.pause',
      resourceKind: 'promotion',
      resourceId: existing.id,
      before: { status: 'active' },
      after: { status: 'paused' },
      impersonatedStoreId: input.storeId,
      requestId: input.requestId,
    });
    paused++;
    pausedIds.push(existing.id);
  }
  if (paused > 0) {
    await notifySummaryToStoreOwners({
      storeId: input.storeId,
      action: 'paused promotions',
      count: paused,
      deepLink: '/retailer/promotions',
      sampleIds: pausedIds,
    });
  }
  return ok({ paused, skipped: input.body.promotionIds.length - paused });
}

export async function generateVouchers(input: {
  auth: Auth;
  storeId: string;
  id: string;
  body: z.infer<typeof VoucherGenerateBody>;
  requestId: string;
}) {
  const promo = await db.query.promotions.findFirst({
    where: and(eq(promotions.id, input.id), eq(promotions.storeId, input.storeId)),
  });
  if (!promo) throw new AppError(404, ErrorCode.NotFound, 'Promotion not found');
  const codes = generateCodes(input.body.count, input.body.prefix ?? '');
  const rows = codes.map((code) => ({
    id: newId(IdPrefix.VoucherCode),
    promotionId: promo.id,
    code,
  }));
  await db.insert(voucherCodes).values(rows);
  await recordAudit({
    actor: input.auth,
    action: 'promotion.voucher_generate',
    resourceKind: 'promotion',
    resourceId: promo.id,
    after: { generated: codes.length },
    impersonatedStoreId: input.storeId,
    requestId: input.requestId,
  });
  return ok({ generated: codes.length, sample: codes.slice(0, 5) });
}

export async function exportVouchers(input: {
  storeId: string;
  id: string;
  reply: FastifyReply;
}) {
  const promo = await db.query.promotions.findFirst({
    where: and(eq(promotions.id, input.id), eq(promotions.storeId, input.storeId)),
  });
  if (!promo) throw new AppError(404, ErrorCode.NotFound, 'Promotion not found');
  const rows = await db.query.voucherCodes.findMany({
    where: eq(voucherCodes.promotionId, promo.id),
  });
  const lines = ['code,redeemed_count'];
  for (const r of rows) lines.push(`${r.code},${r.redeemedCount}`);
  const filename = `vouchers-${promo.id}.csv`;
  void input.reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${filename}"`)
    .send(lines.join('\n'));
  return input.reply;
}

export async function listPickupSlots(input: { storeId: string }) {
  await loadStoreOr404(input.storeId);
  const rows = await db.query.storePickupSlots.findMany({
    where: eq(storePickupSlots.storeId, input.storeId),
    orderBy: (t, { asc }) => [asc(t.dayOfWeek), asc(t.startTime)],
  });
  return ok(rows);
}
