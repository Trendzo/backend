/**
 * Retailer promotion CRUD. Scope-locked to retailer's own store.
 */
import { and, count, desc, eq, inArray, sql, sum } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  consumers,
  platformConfig,
  promotionRedemptions,
  promotions,
  retailerAccounts,
  voucherCodes,
} from '@/db/schema/index.js';
import { generateCodes } from '@/shared/promotions/voucher-codes.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { recordAudit } from '@/shared/audit.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import {
  defaultAppliedTo,
  validateConfigForDiscountType,
  type Mechanism,
} from '@/shared/promotions/schemas.js';
import { canTransitionTo, effectiveStatus } from '@/shared/promotions/lifecycle.js';
import { DELEGATION_MODE_DEFAULTS } from '@/db/seed/delegation-modes.js';
import {
  detectAnomalies,
  loadGmvInfluenced,
  loadRefundRates,
  loadTopConsumerCounts,
  loadUniqueConsumers,
  loadVelocityRatios,
} from '@/shared/promotions/anomaly-detector.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  CreateBody,
  ExportVouchersQuery,
  GenerateVouchersBody,
  ListQuery,
  PatchBody,
  ScopeListingBody,
} from './promotions.validators.js';

type Auth = AccessTokenPayload;

async function loadOwnStoreIdOrThrow(retailerId: string): Promise<string> {
  const account = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
  });
  if (!account) throw AppError.unauthorized();
  if (!account.storeId) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'No storefront — submit one before creating promotions',
    );
  }
  return account.storeId;
}

async function loadOwnPromotion(id: string, storeId: string) {
  const promo = await db.query.promotions.findFirst({ where: eq(promotions.id, id) });
  if (!promo) throw new AppError(404, ErrorCode.NotFound, 'Promotion not found');
  if (promo.storeId !== storeId) {
    throw new AppError(403, ErrorCode.NotOwner, 'You do not own this promotion');
  }
  return promo;
}

async function assertDelegationAllows(mechanism: Mechanism): Promise<void> {
  const capKey =
    mechanism === 'offer'
      ? 'delegation_mode__promotions_issuance__offers'
      : mechanism === 'coupon'
        ? 'delegation_mode__promotions_issuance__coupons'
        : 'delegation_mode__promotions_issuance__vouchers';
  const row = await db.query.platformConfig.findFirst({ where: eq(platformConfig.key, capKey) });
  const mode =
    (row?.value as string | null) ??
    DELEGATION_MODE_DEFAULTS[
      capKey.replace('delegation_mode__', '') as keyof typeof DELEGATION_MODE_DEFAULTS
    ] ??
    'locked';
  if (mode !== 'open') {
    throw new AppError(
      403,
      ErrorCode.Forbidden,
      `Issuing ${mechanism}s is currently restricted — contact admin to enable.`,
    );
  }
}

async function transitionPromo(
  auth: Auth,
  promotionId: string,
  to: typeof promotions.$inferSelect.status,
  reason: string | undefined,
  requestId: string | undefined,
) {
  const storeId = await loadOwnStoreIdOrThrow(auth.sub);
  const promo = await loadOwnPromotion(promotionId, storeId);
  if (!canTransitionTo(promo.status, to)) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `Cannot transition from '${promo.status}' to '${to}'`,
    );
  }
  const [updated] = await db
    .update(promotions)
    .set({ status: to })
    .where(eq(promotions.id, promotionId))
    .returning();
  await recordAudit({
    actor: auth,
    action: `promotion.${to}`,
    resourceKind: 'promotion',
    resourceId: promotionId,
    before: { status: promo.status },
    after: { status: to },
    note: reason ?? null,
    requestId: requestId ?? null,
  });
  const u = updated!;
  return {
    ...u,
    effectiveStatus: effectiveStatus(u.status, u.validFrom, u.validUntil, u.totalUses, u.redeemedCount),
  };
}

export async function getDelegationModes() {
  const capKeys = [
    'delegation_mode__promotions_issuance__offers',
    'delegation_mode__promotions_issuance__coupons',
    'delegation_mode__promotions_issuance__vouchers',
  ];
  const rows = await db.query.platformConfig.findMany({ where: inArray(platformConfig.key, capKeys) });
  const overrides = Object.fromEntries(rows.map((r) => [r.key, r.value as string]));
  return ok({
    offers: (overrides['delegation_mode__promotions_issuance__offers'] ??
      DELEGATION_MODE_DEFAULTS['promotions_issuance__offers']) as 'open' | 'locked',
    coupons: (overrides['delegation_mode__promotions_issuance__coupons'] ??
      DELEGATION_MODE_DEFAULTS['promotions_issuance__coupons']) as 'open' | 'locked',
    vouchers: (overrides['delegation_mode__promotions_issuance__vouchers'] ??
      DELEGATION_MODE_DEFAULTS['promotions_issuance__vouchers']) as 'open' | 'locked',
  });
}

export async function getClubbingPolicy() {
  const APPLIED_TO_ORDER = ['retailer_promo', 'platform_promo', 'coupon', 'shipping', 'loyalty'] as const;
  const rows = await db.query.clubbingMatrixEntries.findMany();
  const lookup = new Map(rows.map((r) => [`${r.appliedToA}:${r.appliedToB}`, r]));
  const cells: Array<{
    appliedToA: (typeof APPLIED_TO_ORDER)[number];
    appliedToB: (typeof APPLIED_TO_ORDER)[number];
    defaultValue: 'allowed' | 'disallowed' | 'always_allowed';
    note: string | null;
    seeded: boolean;
  }> = [];
  for (let i = 0; i < APPLIED_TO_ORDER.length; i++) {
    for (let j = i; j < APPLIED_TO_ORDER.length; j++) {
      const a = APPLIED_TO_ORDER[i]!;
      const b = APPLIED_TO_ORDER[j]!;
      const hit = lookup.get(`${a}:${b}`);
      cells.push({
        appliedToA: a,
        appliedToB: b,
        defaultValue: hit?.defaultValue ?? 'allowed',
        note: hit?.note ?? null,
        seeded: !!hit,
      });
    }
  }
  return ok(cells);
}

export async function listPromotions(input: { auth: Auth; query: z.infer<typeof ListQuery> }) {
  const storeId = await loadOwnStoreIdOrThrow(input.auth.sub);
  const conds = [eq(promotions.storeId, storeId)];
  if (input.query.status) {
    if (input.query.status === 'scheduled') {
      conds.push(eq(promotions.status, 'active'));
      conds.push(sql`${promotions.validFrom} > NOW()`);
    } else if (input.query.status === 'active') {
      conds.push(eq(promotions.status, 'active'));
      conds.push(sql`${promotions.validFrom} <= NOW()`);
      conds.push(sql`${promotions.validUntil} > NOW()`);
    } else {
      conds.push(eq(promotions.status, input.query.status));
    }
  }
  if (input.query.mechanism) conds.push(eq(promotions.mechanism, input.query.mechanism));
  if (input.query.listingId) {
    conds.push(
      sql`${promotions.scope} @> ${JSON.stringify({ listingIds: [input.query.listingId] })}::jsonb`,
    );
  }
  if (input.query.excludedListingId) {
    conds.push(
      sql`${promotions.scope} @> ${JSON.stringify({ excludeListingIds: [input.query.excludedListingId] })}::jsonb`,
    );
  }

  const rows = await db.query.promotions.findMany({
    where: and(...conds),
    orderBy: desc(promotions.createdAt),
  });
  const now = new Date();
  return ok(
    rows.map((p) => ({
      ...p,
      effectiveStatus: effectiveStatus(
        p.status,
        p.validFrom,
        p.validUntil,
        p.totalUses,
        p.redeemedCount,
        now,
      ),
    })),
  );
}

export async function getPromotion(input: { auth: Auth; id: string }) {
  const storeId = await loadOwnStoreIdOrThrow(input.auth.sub);
  const promo = await loadOwnPromotion(input.id, storeId);
  const now = new Date();
  return ok({
    ...promo,
    effectiveStatus: effectiveStatus(
      promo.status,
      promo.validFrom,
      promo.validUntil,
      promo.totalUses,
      promo.redeemedCount,
      now,
    ),
  });
}

export async function createPromotion(input: { auth: Auth; body: z.infer<typeof CreateBody> }) {
  const storeId = await loadOwnStoreIdOrThrow(input.auth.sub);
  await assertDelegationAllows(input.body.mechanism);

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
    defaultAppliedTo(input.body.mechanism, 'retailer', input.body.discountType);

  const id = newId(IdPrefix.Promotion);
  const [created] = await db
    .insert(promotions)
    .values({
      id,
      storeId,
      name: input.body.name,
      mechanism: input.body.mechanism,
      discountType: input.body.discountType,
      issuerType: 'retailer',
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
  return ok(created);
}

export async function patchPromotion(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof PatchBody>;
}) {
  const storeId = await loadOwnStoreIdOrThrow(input.auth.sub);
  const promo = await loadOwnPromotion(input.id, storeId);
  if (['expired', 'exhausted', 'revoked'].includes(promo.status)) {
    throw new AppError(409, ErrorCode.InvalidState, `Cannot edit a promotion in '${promo.status}'`);
  }

  const updates: Partial<typeof promotions.$inferInsert> = {};
  const body = input.body;
  if (body.name !== undefined) updates.name = body.name;
  if (body.appliedTo !== undefined) updates.appliedTo = body.appliedTo;
  if (body.config !== undefined) {
    const validated = validateConfigForDiscountType(promo.discountType, body.config);
    updates.config = validated as unknown as Record<string, unknown>;
  }
  if (body.scope !== undefined) updates.scope = body.scope as Record<string, unknown>;
  if (body.stackableWith !== undefined) updates.stackableWith = body.stackableWith;
  if (body.nonStackable !== undefined) updates.nonStackable = body.nonStackable;
  if (body.totalUses !== undefined) updates.totalUses = body.totalUses;
  if (body.perConsumerLimit !== undefined) updates.perConsumerLimit = body.perConsumerLimit;
  if (body.validFrom !== undefined) updates.validFrom = body.validFrom;
  if (body.validUntil !== undefined) updates.validUntil = body.validUntil;

  const newFrom = updates.validFrom ?? promo.validFrom;
  const newUntil = updates.validUntil ?? promo.validUntil;
  if (newUntil <= newFrom) {
    throw new AppError(422, ErrorCode.ValidationError, 'validUntil must be strictly after validFrom');
  }

  const [updated] = await db
    .update(promotions)
    .set(updates)
    .where(eq(promotions.id, promo.id))
    .returning();
  return ok(updated);
}

export async function patchScopeListing(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof ScopeListingBody>;
}) {
  const storeId = await loadOwnStoreIdOrThrow(input.auth.sub);
  const promo = await loadOwnPromotion(input.id, storeId);
  const { listingId, action } = input.body;

  const TERMINAL = ['expired', 'exhausted', 'revoked'];
  if (TERMINAL.includes(promo.status)) {
    throw new AppError(409, ErrorCode.InvalidState, 'Cannot modify scope of a terminal promotion');
  }

  const scope = (promo.scope ?? {}) as {
    listingIds?: string[];
    excludeListingIds?: string[];
    [k: string]: unknown;
  };
  let listingIds = scope.listingIds ?? [];
  let excludeListingIds = scope.excludeListingIds ?? [];

  if (action === 'include') {
    if (!listingIds.includes(listingId)) listingIds = [...listingIds, listingId];
    excludeListingIds = excludeListingIds.filter((x) => x !== listingId);
  } else if (action === 'uninclude') {
    listingIds = listingIds.filter((x) => x !== listingId);
  } else if (action === 'exclude') {
    if (!excludeListingIds.includes(listingId)) excludeListingIds = [...excludeListingIds, listingId];
    listingIds = listingIds.filter((x) => x !== listingId);
  } else {
    excludeListingIds = excludeListingIds.filter((x) => x !== listingId);
  }

  const newScope = {
    ...scope,
    ...(listingIds.length ? { listingIds } : { listingIds: [] }),
    ...(excludeListingIds.length ? { excludeListingIds } : { excludeListingIds: [] }),
  };

  await db.update(promotions).set({ scope: newScope }).where(eq(promotions.id, promo.id));
  return ok({ id: promo.id, scope: newScope });
}

export async function pausePromotion(input: {
  auth: Auth;
  id: string;
  body: { reason?: string | undefined } | undefined;
  requestId: string;
}) {
  return ok(await transitionPromo(input.auth, input.id, 'paused', input.body?.reason, input.requestId));
}

export async function resumePromotion(input: { auth: Auth; id: string; requestId: string }) {
  return ok(await transitionPromo(input.auth, input.id, 'active', undefined, input.requestId));
}

export async function revokePromotion(input: {
  auth: Auth;
  id: string;
  body: { reason: string };
  requestId: string;
}) {
  return ok(await transitionPromo(input.auth, input.id, 'revoked', input.body.reason, input.requestId));
}

export async function activatePromotion(input: { auth: Auth; id: string; requestId: string }) {
  return ok(await transitionPromo(input.auth, input.id, 'active', undefined, input.requestId));
}

export async function generateVouchers(input: {
  auth: Auth;
  body: z.infer<typeof GenerateVouchersBody>;
}) {
  const storeId = await loadOwnStoreIdOrThrow(input.auth.sub);

  const promo = await db.query.promotions.findFirst({
    where: and(eq(promotions.id, input.body.promotionId), eq(promotions.storeId, storeId)),
  });
  if (!promo) throw new AppError(404, ErrorCode.NotFound, 'Promotion not found');
  if (promo.mechanism !== 'voucher') {
    throw new AppError(409, ErrorCode.InvalidState, 'Only voucher promotions can have codes generated');
  }

  const targetIds = input.body.consumerIds ?? null;
  if (targetIds) {
    const dedup = Array.from(new Set(targetIds));
    const found = await db.query.consumers.findMany({
      where: inArray(consumers.id, dedup),
      columns: { id: true },
    });
    if (found.length !== dedup.length) {
      const known = new Set(found.map((c) => c.id));
      const missing = dedup.filter((id) => !known.has(id)).slice(0, 5);
      throw new AppError(
        400,
        ErrorCode.ValidationError,
        `Unknown consumer ids: ${missing.join(', ')}${dedup.length - known.size > 5 ? '…' : ''}`,
      );
    }
  }

  const wantCount = targetIds ? targetIds.length : input.body.count!;
  const codes = generateCodes(wantCount, input.body.prefix ? input.body.prefix + '-' : '');
  const rows = codes.map((code, i) => ({
    id: newId(IdPrefix.VoucherCode),
    promotionId: promo.id,
    code,
    assignedConsumerId: targetIds ? targetIds[i]! : null,
  }));

  await db.insert(voucherCodes).values(rows);
  return ok({
    generated: codes.length,
    codes: rows.map((r) => ({ code: r.code, assignedConsumerId: r.assignedConsumerId })),
  });
}

export async function exportVouchers(input: {
  auth: Auth;
  query: z.infer<typeof ExportVouchersQuery>;
  reply: FastifyReply;
}) {
  const storeId = await loadOwnStoreIdOrThrow(input.auth.sub);

  const promo = await db.query.promotions.findFirst({
    where: and(eq(promotions.id, input.query.promotionId), eq(promotions.storeId, storeId)),
  });
  if (!promo) throw new AppError(404, ErrorCode.NotFound, 'Promotion not found');

  const allCodes = await db.query.voucherCodes.findMany({
    where: eq(voucherCodes.promotionId, promo.id),
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });

  const anyAssigned = allCodes.some((c) => c.assignedConsumerId);
  const header = anyAssigned
    ? 'code,redeemed_count,total_uses,assigned_consumer_id'
    : 'code,redeemed_count,total_uses';
  const lines = [header];
  for (const c of allCodes) {
    const base = `${c.code},${c.redeemedCount},${c.totalUses ?? ''}`;
    lines.push(anyAssigned ? `${base},${c.assignedConsumerId ?? ''}` : base);
  }

  void input.reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="vouchers-${promo.id}.csv"`)
    .send(lines.join('\n'));
  return input.reply;
}

export async function getPerformance(input: { auth: Auth }) {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, input.auth.sub),
  });
  if (!retailer?.storeId) return ok([]);

  const storePromos = await db.query.promotions.findMany({
    where: eq(promotions.storeId, retailer.storeId),
  });
  if (storePromos.length === 0) return ok([]);

  const promoIds = storePromos.map((p) => p.id);
  const stats = await db
    .select({
      promotionId: promotionRedemptions.promotionId,
      redemptions: count(),
      totalDiscountPaise: sum(promotionRedemptions.amountAppliedPaise),
    })
    .from(promotionRedemptions)
    .where(inArray(promotionRedemptions.promotionId, promoIds))
    .groupBy(promotionRedemptions.promotionId);

  const [uniqueMap, gmvMap, refundMap, topMap, velocityMap] = await Promise.all([
    loadUniqueConsumers(promoIds),
    loadGmvInfluenced(promoIds),
    loadRefundRates(promoIds),
    loadTopConsumerCounts(promoIds),
    loadVelocityRatios(promoIds),
  ]);

  const statsMap = new Map(stats.map((s) => [s.promotionId, s]));
  const promoMap = new Map(storePromos.map((p) => [p.id, p.name]));

  return ok(
    promoIds.map((id) => {
      const s = statsMap.get(id);
      const redemptions = Number(s?.redemptions ?? 0);
      const totalDiscountPaise = Number(s?.totalDiscountPaise ?? 0);
      const uniqueConsumers = uniqueMap.get(id) ?? 0;
      const gmvInfluencedPaise = gmvMap.get(id) ?? 0;
      const refundRateBp = refundMap.get(id) ?? 0;
      const topConsumerCount = topMap.get(id) ?? 0;
      const velocityRatio = velocityMap.get(id) ?? 0;
      const anomalyReasons = detectAnomalies(
        {
          promotionId: id,
          redemptionsTotal: redemptions,
          uniqueConsumers,
          topConsumerCount,
          refundRateBp,
        },
        velocityRatio,
      );
      return {
        promotionId: id,
        name: promoMap.get(id) ?? id,
        redemptions,
        uniqueConsumers,
        totalDiscountPaise,
        gmvInfluencePaise: totalDiscountPaise,
        gmvInfluencedPaise,
        refundRateBp,
        aovLiftBp: 0,
        anomalyFlagged: anomalyReasons.length > 0,
        anomalyReasons,
      };
    }),
  );
}
