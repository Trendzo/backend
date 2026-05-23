/**
 * Admin promotions: CRUD, lifecycle, analytics, targeted drops, voucher codes.
 */
import { and, count, desc, eq, inArray, isNull, sql, sum } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  consumers,
  loyaltyTransactions,
  orders,
  platformConfig,
  promotionConsumerGrants,
  promotionRedemptions,
  promotions,
  refunds,
  retailerAccounts,
  retailerStores,
  targetedDrops,
  voucherCodes,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { recordAudit } from '@/shared/audit.js';
import { notify } from '@/shared/notify.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import {
  defaultAppliedTo,
  validateConfigForDiscountType,
} from '@/shared/promotions/schemas.js';
import { canTransitionTo, effectiveStatus } from '@/shared/promotions/lifecycle.js';
import { generateCodes } from '@/shared/promotions/voucher-codes.js';
import {
  detectAnomalies,
  loadRefundRates,
  loadTopConsumerCounts,
  loadUniqueConsumers,
  loadVelocityRatios,
} from '@/shared/promotions/anomaly-detector.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  CreateBody,
  GenerateVouchersBody,
  ListQuery,
  PatchBody,
  TargetedDropBody,
} from './promotions.validators.js';

type Auth = AccessTokenPayload;

async function loadPromotion(id: string) {
  const promo = await db.query.promotions.findFirst({ where: eq(promotions.id, id) });
  if (!promo) throw new AppError(404, ErrorCode.NotFound, 'Promotion not found');
  return promo;
}

export async function listPromotions(input: { query: z.infer<typeof ListQuery> }) {
  const { status, mechanism, discountType, storeId, retailerId, platformOnly } = input.query;
  const conds = [];
  if (status) {
    if (status === 'scheduled') {
      conds.push(eq(promotions.status, 'active'));
      conds.push(sql`${promotions.validFrom} > NOW()`);
    } else if (status === 'active') {
      conds.push(eq(promotions.status, 'active'));
      conds.push(sql`${promotions.validFrom} <= NOW()`);
      conds.push(sql`${promotions.validUntil} > NOW()`);
    } else {
      conds.push(eq(promotions.status, status));
    }
  }
  if (mechanism) conds.push(eq(promotions.mechanism, mechanism));
  if (discountType) conds.push(eq(promotions.discountType, discountType));
  if (storeId) conds.push(eq(promotions.storeId, storeId));
  if (retailerId && !storeId) {
    const retailer = await db.query.retailerAccounts.findFirst({
      where: eq(retailerAccounts.id, retailerId),
      columns: { storeId: true },
    });
    if (retailer?.storeId) conds.push(eq(promotions.storeId, retailer.storeId));
    else conds.push(eq(promotions.storeId, '__no_match__'));
  }
  if (platformOnly) conds.push(isNull(promotions.storeId));

  const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);

  const rows = await db.query.promotions.findMany({
    ...(where && { where }),
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

export async function getPromotion(id: string) {
  const promo = await loadPromotion(id);
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

export async function createPromotion(input: { body: z.infer<typeof CreateBody> }) {
  const body = input.body;

  let validatedConfig;
  try {
    validatedConfig = validateConfigForDiscountType(body.discountType, body.config);
  } catch (e) {
    throw new AppError(
      422,
      ErrorCode.ValidationError,
      `Invalid config for discountType '${body.discountType}'`,
      (e as { issues?: unknown }).issues ?? String(e),
    );
  }

  if (body.storeId) {
    const store = await db.query.retailerStores.findFirst({
      where: eq(retailerStores.id, body.storeId),
    });
    if (!store) {
      throw new AppError(404, ErrorCode.NotFound, `Store ${body.storeId} not found`);
    }
  }

  const appliedTo =
    body.appliedTo ?? defaultAppliedTo(body.mechanism, 'admin', body.discountType);

  if (body.validUntil.getTime() <= body.validFrom.getTime()) {
    throw new AppError(422, ErrorCode.ValidationError, 'validUntil must be strictly after validFrom');
  }

  const id = newId(IdPrefix.Promotion);
  const [created] = await db
    .insert(promotions)
    .values({
      id,
      ...(body.storeId !== undefined && { storeId: body.storeId }),
      name: body.name,
      mechanism: body.mechanism,
      discountType: body.discountType,
      issuerType: 'admin',
      appliedTo,
      scope: (body.scope ?? {}) as Record<string, unknown>,
      config: validatedConfig as unknown as Record<string, unknown>,
      stackableWith: body.stackableWith,
      nonStackable: body.nonStackable,
      ...(body.totalUses !== undefined && body.totalUses !== null && { totalUses: body.totalUses }),
      ...(body.perConsumerLimit !== undefined &&
        body.perConsumerLimit !== null && { perConsumerLimit: body.perConsumerLimit }),
      validFrom: body.validFrom,
      validUntil: body.validUntil,
      status: body.status ?? 'draft',
    })
    .returning();
  if (!created) throw AppError.internal('promotion insert returned no row');
  return ok({
    ...created,
    effectiveStatus: effectiveStatus(
      created.status,
      created.validFrom,
      created.validUntil,
      created.totalUses,
      created.redeemedCount,
    ),
  });
}

export async function patchPromotion(input: {
  id: string;
  body: z.infer<typeof PatchBody>;
}) {
  const promo = await loadPromotion(input.id);
  if (['expired', 'exhausted', 'revoked'].includes(promo.status)) {
    throw new AppError(409, ErrorCode.InvalidState, `Cannot edit a promotion in '${promo.status}'`);
  }

  const body = input.body;
  const updates: Partial<typeof promotions.$inferInsert> = {};

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
  if (!updated) throw AppError.internal('promotion update returned no row');
  return ok({
    ...updated,
    effectiveStatus: effectiveStatus(
      updated.status,
      updated.validFrom,
      updated.validUntil,
      updated.totalUses,
      updated.redeemedCount,
    ),
  });
}

async function transition(
  id: string,
  to: typeof promotions.$inferSelect.status,
  actor: Auth,
  reason: string | undefined,
  requestId: string | undefined,
) {
  const promo = await loadPromotion(id);
  if (!canTransitionTo(promo.status, to)) {
    throw new AppError(409, ErrorCode.InvalidState, `Cannot transition from '${promo.status}' to '${to}'`);
  }
  const [updated] = await db
    .update(promotions)
    .set({ status: to })
    .where(eq(promotions.id, id))
    .returning();
  await recordAudit({
    actor,
    action: `promotion.${to}`,
    resourceKind: 'promotion',
    resourceId: id,
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

export async function pausePromotion(input: {
  auth: Auth;
  id: string;
  body: { reason?: string | undefined } | undefined;
  requestId: string;
}) {
  const r = await transition(input.id, 'paused', input.auth, input.body?.reason, input.requestId);
  return ok(r);
}

export async function resumePromotion(input: { auth: Auth; id: string; requestId: string }) {
  const r = await transition(input.id, 'active', input.auth, undefined, input.requestId);
  return ok(r);
}

export async function revokePromotion(input: {
  auth: Auth;
  id: string;
  body: { reason: string };
  requestId: string;
}) {
  const r = await transition(input.id, 'revoked', input.auth, input.body.reason, input.requestId);
  return ok(r);
}

export async function activatePromotion(input: { auth: Auth; id: string; requestId: string }) {
  const r = await transition(input.id, 'active', input.auth, undefined, input.requestId);
  return ok(r);
}

export async function getPerformance() {
  // Per-promo redemption + GMV aggregate (one row per promo with at least one redemption).
  const stats = await db
    .select({
      promotionId: promotionRedemptions.promotionId,
      redemptions: count(),
      gmvInfluencePaise: sum(promotionRedemptions.amountAppliedPaise),
      promoOrdersAvgPaise: sql<number>`AVG(${orders.grandTotalPaise})::int`,
      promoOrdersCount: sql<number>`COUNT(DISTINCT ${promotionRedemptions.orderId})::int`,
    })
    .from(promotionRedemptions)
    .innerJoin(orders, eq(orders.id, promotionRedemptions.orderId))
    .groupBy(promotionRedemptions.promotionId);

  if (stats.length === 0) return ok([]);

  const promoIds = stats.map((s) => s.promotionId);

  // Baseline AOV across all orders that did NOT redeem any promo.
  const [baselineRow] = await db
    .select({
      avgPaise: sql<number>`AVG(${orders.grandTotalPaise})::int`,
    })
    .from(orders)
    .where(
      sql`NOT EXISTS (SELECT 1 FROM ${promotionRedemptions} pr WHERE pr.order_id = ${orders.id})`,
    );
  const baselineAovPaise = Number(baselineRow?.avgPaise ?? 0);

  // Refund count per promotion (distinct orders with a refund row).
  const refundStats = await db
    .select({
      promotionId: promotionRedemptions.promotionId,
      refundedOrders: sql<number>`COUNT(DISTINCT ${promotionRedemptions.orderId})::int`,
    })
    .from(promotionRedemptions)
    .innerJoin(refunds, eq(refunds.orderId, promotionRedemptions.orderId))
    .where(inArray(promotionRedemptions.promotionId, promoIds))
    .groupBy(promotionRedemptions.promotionId);
  const refundMap = new Map(refundStats.map((r) => [r.promotionId, Number(r.refundedOrders)]));

  const promoRows = await db.query.promotions.findMany({
    where: inArray(promotions.id, promoIds),
  });
  const promoMap = new Map(promoRows.map((p) => [p.id, p.name]));

  return ok(
    stats.map((s) => {
      const promoAov = Number(s.promoOrdersAvgPaise ?? 0);
      const aovLiftBp =
        baselineAovPaise > 0
          ? Math.round(((promoAov - baselineAovPaise) / baselineAovPaise) * 10000)
          : 0;
      const promoOrders = Number(s.promoOrdersCount ?? 0);
      const refunded = refundMap.get(s.promotionId) ?? 0;
      const refundRateBp = promoOrders > 0 ? Math.round((refunded / promoOrders) * 10000) : 0;
      return {
        promotionId: s.promotionId,
        name: promoMap.get(s.promotionId) ?? s.promotionId,
        redemptions: Number(s.redemptions),
        gmvInfluencePaise: Number(s.gmvInfluencePaise ?? 0),
        promoAovPaise: promoAov,
        baselineAovPaise,
        aovLiftBp,
        refundedOrders: refunded,
        refundRateBp,
        anomalyFlagged: false,
      };
    }),
  );
}

async function loadComparison(dim: 'mechanism' | 'discountType') {
  const col = dim === 'mechanism' ? promotions.mechanism : promotions.discountType;
  const stats = await db
    .select({
      dim: col,
      promoCount: sql<number>`COUNT(DISTINCT ${promotions.id})::int`,
      redemptions: count(promotionRedemptions.id),
      totalDiscountPaise: sql<number>`COALESCE(SUM(${promotionRedemptions.amountAppliedPaise}), 0)::bigint`,
      gmvInfluencedPaise: sql<number>`COALESCE(SUM(${orders.grandTotalPaise}), 0)::bigint`,
      uniqueConsumers: sql<number>`COUNT(DISTINCT ${promotionRedemptions.consumerId})::int`,
    })
    .from(promotions)
    .leftJoin(promotionRedemptions, eq(promotionRedemptions.promotionId, promotions.id))
    .leftJoin(orders, eq(orders.id, promotionRedemptions.orderId))
    .groupBy(col);

  return ok(
    stats.map((s) => ({
      key: String(s.dim),
      promoCount: Number(s.promoCount ?? 0),
      redemptions: Number(s.redemptions ?? 0),
      totalDiscountPaise: Number(s.totalDiscountPaise ?? 0),
      gmvInfluencedPaise: Number(s.gmvInfluencedPaise ?? 0),
      uniqueConsumers: Number(s.uniqueConsumers ?? 0),
    })),
  );
}

export async function getPerformanceByMechanism() {
  return loadComparison('mechanism');
}

export async function getPerformanceByDiscountType() {
  return loadComparison('discountType');
}

export async function listAnomalies() {
  const active = await db.query.promotions.findMany({
    where: eq(promotions.status, 'active'),
    columns: { id: true, name: true, mechanism: true },
  });
  if (active.length === 0) return ok([]);
  const promoIds = active.map((p) => p.id);
  const nameMap = new Map(active.map((p) => [p.id, p.name]));

  const [uniqueMap, refundMap, topMap, velocityMap, redemptionsMap] = await Promise.all([
    loadUniqueConsumers(promoIds),
    loadRefundRates(promoIds),
    loadTopConsumerCounts(promoIds),
    loadVelocityRatios(promoIds),
    (async () => {
      const r = await db
        .select({ promotionId: promotionRedemptions.promotionId, c: count() })
        .from(promotionRedemptions)
        .where(inArray(promotionRedemptions.promotionId, promoIds))
        .groupBy(promotionRedemptions.promotionId);
      return new Map(r.map((x) => [x.promotionId, Number(x.c)]));
    })(),
  ]);

  const now = new Date().toISOString();
  const out: Array<Record<string, unknown>> = [];
  for (const id of promoIds) {
    const redemptions = redemptionsMap.get(id) ?? 0;
    const uniqueConsumers = uniqueMap.get(id) ?? 0;
    const topConsumerCount = topMap.get(id) ?? 0;
    const refundRateBp = refundMap.get(id) ?? 0;
    const velocityRatio = velocityMap.get(id) ?? 0;
    const reasons = detectAnomalies(
      {
        promotionId: id,
        redemptionsTotal: redemptions,
        uniqueConsumers,
        topConsumerCount,
        refundRateBp,
      },
      velocityRatio,
    );
    for (const r of reasons) {
      const severity: 'low' | 'medium' | 'high' =
        r === 'refund_spike' || r === 'velocity_spike' ? 'high' : 'medium';
      const meta =
        r === 'velocity_spike'
          ? { metric: '1h vs 24h-avg ratio', value: velocityRatio.toFixed(2) + '×', threshold: '5×' }
          : r === 'refund_spike'
            ? {
                metric: 'refund rate',
                value: (refundRateBp / 100).toFixed(2) + '%',
                threshold: '30%',
              }
            : {
                metric: 'top-consumer share',
                value:
                  redemptions > 0
                    ? ((topConsumerCount / redemptions) * 100).toFixed(1) + '%'
                    : '0%',
                threshold: '50%',
              };
      out.push({
        id: `${id}:${r}`,
        promotionId: id,
        promotionName: nameMap.get(id) ?? id,
        kind: r,
        detectedAt: now,
        severity,
        metric: meta.metric,
        value: meta.value,
        threshold: meta.threshold,
        status: 'open',
        consumersInvolved: r === 'consumer_concentration' ? topConsumerCount : uniqueConsumers,
      });
    }
  }
  return ok(out);
}

export async function getAnomalyById(_id: string) {
  throw new AppError(404, ErrorCode.NotFound, 'Anomaly not found');
}

export async function listTargetedDrops() {
  const rows = await db
    .select({
      id: targetedDrops.id,
      promotionId: targetedDrops.promotionId,
      cohortKind: targetedDrops.cohortKind,
      audienceSize: targetedDrops.audienceSize,
      pushedAt: targetedDrops.pushedAt,
      promotionName: promotions.name,
    })
    .from(targetedDrops)
    .innerJoin(promotions, eq(promotions.id, targetedDrops.promotionId))
    .orderBy(desc(targetedDrops.pushedAt));

  if (rows.length === 0) return ok([]);

  const grantStats = await db
    .select({
      promotionId: promotionConsumerGrants.promotionId,
      consumerId: promotionConsumerGrants.consumerId,
    })
    .from(promotionConsumerGrants)
    .where(
      inArray(
        promotionConsumerGrants.promotionId,
        rows.map((r) => r.promotionId),
      ),
    );
  const redemptionsByPromo = await db
    .select({
      promotionId: promotionRedemptions.promotionId,
      consumerId: promotionRedemptions.consumerId,
    })
    .from(promotionRedemptions)
    .where(
      inArray(
        promotionRedemptions.promotionId,
        rows.map((r) => r.promotionId),
      ),
    );
  const redemptionSet = new Set(redemptionsByPromo.map((r) => `${r.promotionId}:${r.consumerId}`));
  const redeemedCountByPromo = new Map<string, number>();
  for (const g of grantStats) {
    if (redemptionSet.has(`${g.promotionId}:${g.consumerId}`)) {
      redeemedCountByPromo.set(g.promotionId, (redeemedCountByPromo.get(g.promotionId) ?? 0) + 1);
    }
  }

  return ok(
    rows.map((r) => ({
      id: r.id,
      name: `${r.promotionName} → ${r.cohortKind.replace(/_/g, ' ')}`,
      promotionId: r.promotionId,
      promotionName: r.promotionName,
      cohortKind: r.cohortKind,
      audienceSize: r.audienceSize,
      pushedAt: r.pushedAt.toISOString(),
      redemptionCount: redeemedCountByPromo.get(r.promotionId) ?? 0,
    })),
  );
}

async function resolveCohort(cohort: string, explicitIds: string[] | undefined): Promise<string[]> {
  if (cohort === 'specific_consumers') {
    if (!explicitIds || explicitIds.length === 0) {
      throw new AppError(400, ErrorCode.ValidationError, 'consumerIds required for specific_consumers cohort');
    }
    const dedup = Array.from(new Set(explicitIds));
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
    return dedup;
  }
  if (cohort === 'all') {
    const rows = await db.query.consumers.findMany({ columns: { id: true }, limit: 5000 });
    return rows.map((r) => r.id);
  }
  const tier = cohort.replace('loyalty_', '') as 'bronze' | 'silver' | 'gold' | 'platinum';
  const cfgRows = await db.query.platformConfig.findMany({
    where: inArray(platformConfig.key, [
      'loyalty_tier_silver_min',
      'loyalty_tier_gold_min',
      'loyalty_tier_platinum_min',
    ]),
  });
  const silver = (cfgRows.find((c) => c.key === 'loyalty_tier_silver_min')?.value as number | undefined) ?? 500;
  const gold = (cfgRows.find((c) => c.key === 'loyalty_tier_gold_min')?.value as number | undefined) ?? 2000;
  const plat = (cfgRows.find((c) => c.key === 'loyalty_tier_platinum_min')?.value as number | undefined) ?? 5000;
  const bounds: Record<typeof tier, { min: number; max: number | null }> = {
    bronze: { min: 0, max: silver - 1 },
    silver: { min: silver, max: gold - 1 },
    gold: { min: gold, max: plat - 1 },
    platinum: { min: plat, max: null },
  };
  const b = bounds[tier];

  const latestBalances = await db
    .select({
      consumerId: loyaltyTransactions.consumerId,
      bal: sql<number>`(ARRAY_AGG(${loyaltyTransactions.balanceAfterPoints} ORDER BY ${loyaltyTransactions.at} DESC))[1]`,
    })
    .from(loyaltyTransactions)
    .groupBy(loyaltyTransactions.consumerId);
  return latestBalances
    .filter((r) => Number(r.bal) >= b.min && (b.max === null || Number(r.bal) <= b.max))
    .map((r) => r.consumerId);
}

export async function pushTargetedDrop(input: {
  auth: Auth;
  body: z.infer<typeof TargetedDropBody>;
  requestId: string;
}) {
  const { auth, body } = input;
  const promo = await db.query.promotions.findFirst({
    where: and(eq(promotions.id, body.promotionId), eq(promotions.issuerType, 'admin')),
  });
  if (!promo) throw new AppError(404, ErrorCode.NotFound, 'Platform promotion not found');
  if (promo.mechanism === 'offer') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'Offers auto-apply; targeted drop is for coupons/vouchers only.',
    );
  }

  const targetIds = await resolveCohort(body.cohort, body.consumerIds);
  if (targetIds.length === 0) {
    throw new AppError(400, ErrorCode.ValidationError, 'Cohort resolved to zero consumers');
  }

  const existing = await db
    .select({ consumerId: promotionConsumerGrants.consumerId })
    .from(promotionConsumerGrants)
    .where(
      and(
        eq(promotionConsumerGrants.promotionId, promo.id),
        inArray(promotionConsumerGrants.consumerId, targetIds),
      ),
    );
  const existingSet = new Set(existing.map((r) => r.consumerId));
  const freshIds = targetIds.filter((id) => !existingSet.has(id));

  const dropId = newId(IdPrefix.TargetedDrop);
  await db.transaction(async (tx) => {
    await tx.insert(targetedDrops).values({
      id: dropId,
      promotionId: promo.id,
      cohortKind: body.cohort,
      audienceSize: targetIds.length,
      pushedByAdminId: auth.sub,
    });

    if (freshIds.length === 0) return;

    if (promo.mechanism === 'voucher') {
      const codes = generateCodes(freshIds.length);
      for (let i = 0; i < freshIds.length; i++) {
        const voucherId = newId(IdPrefix.VoucherCode);
        const consumerId = freshIds[i]!;
        await tx.insert(voucherCodes).values({
          id: voucherId,
          promotionId: promo.id,
          code: codes[i]!,
          totalUses: 1,
          assignedConsumerId: consumerId,
        });
        await tx.insert(promotionConsumerGrants).values({
          id: newId(IdPrefix.PromotionGrant),
          promotionId: promo.id,
          consumerId,
          assignedByAdminId: auth.sub,
          source: 'targeted_drop',
          voucherCodeId: voucherId,
        });
      }
    } else {
      const scope = (promo.scope ?? {}) as Record<string, unknown>;
      const existingTargets = Array.isArray(scope.specificConsumerIds)
        ? (scope.specificConsumerIds as string[])
        : [];
      const merged = Array.from(new Set([...existingTargets, ...freshIds]));
      await tx
        .update(promotions)
        .set({ scope: { ...scope, specificConsumerIds: merged } })
        .where(eq(promotions.id, promo.id));

      for (const consumerId of freshIds) {
        await tx.insert(promotionConsumerGrants).values({
          id: newId(IdPrefix.PromotionGrant),
          promotionId: promo.id,
          consumerId,
          assignedByAdminId: auth.sub,
          source: 'targeted_drop',
        });
      }
    }
  });

  for (const consumerId of freshIds) {
    await notify({
      recipientKind: 'consumer',
      recipientId: consumerId,
      kind: 'promotion',
      title: 'New promotion in your wallet',
      body: `${promo.name} — open the app to redeem.`,
      deepLink: '/consumer/wallet',
      payload: { promotionId: promo.id, mechanism: promo.mechanism },
    }).catch(() => undefined);
  }

  await recordAudit({
    actor: auth,
    action: 'promotion.targeted_drop',
    resourceKind: 'promotion',
    resourceId: promo.id,
    after: {
      dropId,
      cohort: body.cohort,
      audienceSize: targetIds.length,
      granted: freshIds.length,
    },
    requestId: input.requestId,
  });

  return ok({
    dropId,
    promotionId: promo.id,
    cohort: body.cohort,
    audienceSize: targetIds.length,
    granted: freshIds.length,
    skippedExisting: existingSet.size,
  });
}

export async function listVoucherCodes(input: { id: string }) {
  const promo = await db.query.promotions.findFirst({ where: eq(promotions.id, input.id) });
  if (!promo) throw new AppError(404, ErrorCode.NotFound, 'Promotion not found');
  const codes = await db.query.voucherCodes.findMany({
    where: eq(voucherCodes.promotionId, promo.id),
    orderBy: desc(voucherCodes.createdAt),
  });
  return ok(codes);
}

export async function generateVoucherCodes(input: {
  id: string;
  body: z.infer<typeof GenerateVouchersBody>;
}) {
  const promo = await db.query.promotions.findFirst({ where: eq(promotions.id, input.id) });
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
      throw new AppError(400, ErrorCode.ValidationError, `Unknown consumer ids: ${missing.join(', ')}`);
    }
    const codes = generateCodes(dedup.length, input.body.prefix);
    const rows = dedup.map((cid, i) => ({
      id: newId(IdPrefix.VoucherCode),
      promotionId: promo.id,
      code: codes[i]!,
      assignedConsumerId: cid,
    }));
    await db.insert(voucherCodes).values(rows);
    return ok({
      generated: rows.length,
      codes: rows.map((r) => ({ code: r.code, assignedConsumerId: r.assignedConsumerId })),
    });
  }

  const n = input.body.count!;
  const codes = generateCodes(n, input.body.prefix);
  const rows = codes.map((code) => ({
    id: newId(IdPrefix.VoucherCode),
    promotionId: promo.id,
    code,
    assignedConsumerId: null,
  }));
  await db.insert(voucherCodes).values(rows);
  return ok({
    generated: rows.length,
    codes: rows.map((r) => ({ code: r.code, assignedConsumerId: null })),
  });
}

export async function exportVoucherCodes(input: { id: string; reply: FastifyReply }) {
  const promo = await db.query.promotions.findFirst({ where: eq(promotions.id, input.id) });
  if (!promo) throw new AppError(404, ErrorCode.NotFound, 'Promotion not found');

  const codes = await db.query.voucherCodes.findMany({
    where: eq(voucherCodes.promotionId, promo.id),
  });

  const hasAssigned = codes.some((c) => c.assignedConsumerId != null);
  const header = hasAssigned ? 'code,assigned_consumer_id,redeemed_count\n' : 'code,redeemed_count\n';
  const rows = codes.map((c) =>
    hasAssigned
      ? `${c.code},${c.assignedConsumerId ?? ''},${c.redeemedCount}`
      : `${c.code},${c.redeemedCount}`,
  );
  const csv = header + rows.join('\n');

  void input.reply.header('Content-Type', 'text/csv');
  void input.reply.header('Content-Disposition', `attachment; filename="vouchers-${promo.id}.csv"`);
  return input.reply.send(csv);
}
