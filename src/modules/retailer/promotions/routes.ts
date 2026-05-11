import { and, count, desc, eq, inArray, sql, sum } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import { promotionRedemptions, promotions, retailerAccounts, voucherCodes } from '@/db/schema/index.js';
import { generateCodes } from '@/shared/promotions/voucher-codes.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import {
  defaultAppliedTo,
  PromotionCommonSchema,
  PromotionPatchSchema,
  PromotionStatusEnum,
  validateConfigForDiscountType,
  type Mechanism,
} from '@/shared/promotions/schemas.js';
import { canTransitionTo, effectiveStatus } from '@/shared/promotions/lifecycle.js';
import { DELEGATION_MODE_DEFAULTS } from '@/db/seed/delegation-modes.js';

/**
 * Retailer promotion CRUD. Scope-locked to the retailer's own store. Coupon + voucher
 * mutations are gated by Delegation Modes (MVP defaults: offers `open`, others `locked`).
 */
const retailerPromotionRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  // ============ List own-store promotions ============
  app.get(
    '/',
    {
      schema: {
        querystring: z.object({
          status: PromotionStatusEnum.optional(),
          mechanism: z.enum(['offer', 'coupon', 'voucher']).optional(),
          listingId: z.string().optional(),
        }),
      },
    },
    async (req) => {
      const storeId = await loadOwnStoreIdOrThrow(getAuth(req).sub);
      const conds = [eq(promotions.storeId, storeId)];
      if (req.query.status) conds.push(eq(promotions.status, req.query.status));
      if (req.query.mechanism) conds.push(eq(promotions.mechanism, req.query.mechanism));
      if (req.query.listingId) {
        conds.push(sql`${promotions.scope} @> ${JSON.stringify({ listingIds: [req.query.listingId] })}::jsonb`);
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
    },
  );

  // ============ Get one (own store only) ============
  app.get(
    '/:id',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const storeId = await loadOwnStoreIdOrThrow(getAuth(req).sub);
      const promo = await loadOwnPromotion(req.params.id, storeId);
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
    },
  );

  // ============ Create — delegation-gated ============
  app.post(
    '/',
    { schema: { body: PromotionCommonSchema } },
    async (req) => {
      const storeId = await loadOwnStoreIdOrThrow(getAuth(req).sub);
      assertDelegationAllows(req.body.mechanism);

      let validatedConfig;
      try {
        validatedConfig = validateConfigForDiscountType(req.body.discountType, req.body.config);
      } catch (e) {
        throw new AppError(
          422,
          ErrorCode.ValidationError,
          `Invalid config for discountType '${req.body.discountType}'`,
          (e as { issues?: unknown }).issues ?? String(e),
        );
      }

      if (req.body.validUntil.getTime() <= req.body.validFrom.getTime()) {
        throw new AppError(
          422,
          ErrorCode.ValidationError,
          'validUntil must be strictly after validFrom',
        );
      }

      const appliedTo =
        req.body.appliedTo ??
        defaultAppliedTo(req.body.mechanism, 'retailer', req.body.discountType);

      const id = newId(IdPrefix.Promotion);
      const [created] = await db
        .insert(promotions)
        .values({
          id,
          storeId,
          name: req.body.name,
          mechanism: req.body.mechanism,
          discountType: req.body.discountType,
          issuerType: 'retailer',
          appliedTo,
          scope: (req.body.scope ?? {}) as Record<string, unknown>,
          config: validatedConfig as unknown as Record<string, unknown>,
          stackableWith: req.body.stackableWith,
          nonStackable: req.body.nonStackable,
          ...(req.body.totalUses !== undefined &&
            req.body.totalUses !== null && { totalUses: req.body.totalUses }),
          ...(req.body.perConsumerLimit !== undefined &&
            req.body.perConsumerLimit !== null && { perConsumerLimit: req.body.perConsumerLimit }),
          validFrom: req.body.validFrom,
          validUntil: req.body.validUntil,
          status: req.body.status ?? 'draft',
        })
        .returning();
      return ok(created);
    },
  );

  // ============ Patch — own store only ============
  app.patch(
    '/:id',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: PromotionPatchSchema,
      },
    },
    async (req) => {
      const storeId = await loadOwnStoreIdOrThrow(getAuth(req).sub);
      const promo = await loadOwnPromotion(req.params.id, storeId);
      if (['expired', 'exhausted', 'revoked'].includes(promo.status)) {
        throw new AppError(
          409,
          ErrorCode.InvalidState,
          `Cannot edit a promotion in '${promo.status}'`,
        );
      }

      const updates: Partial<typeof promotions.$inferInsert> = {};
      const body = req.body;
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
        throw new AppError(
          422,
          ErrorCode.ValidationError,
          'validUntil must be strictly after validFrom',
        );
      }

      const [updated] = await db
        .update(promotions)
        .set(updates)
        .where(eq(promotions.id, promo.id))
        .returning();
      return ok(updated);
    },
  );

  // ============ Lifecycle: pause / resume / revoke / activate ============
  app.post('/:id/pause', { schema: { params: z.object({ id: z.string() }) } }, async (req) =>
    ok(await transition(getAuth(req).sub, req.params.id, 'paused')),
  );
  app.post('/:id/resume', { schema: { params: z.object({ id: z.string() }) } }, async (req) =>
    ok(await transition(getAuth(req).sub, req.params.id, 'active')),
  );
  app.post('/:id/revoke', { schema: { params: z.object({ id: z.string() }) } }, async (req) =>
    ok(await transition(getAuth(req).sub, req.params.id, 'revoked')),
  );
  app.post('/:id/activate', { schema: { params: z.object({ id: z.string() }) } }, async (req) =>
    ok(await transition(getAuth(req).sub, req.params.id, 'active')),
  );

  // ─────────── helpers ───────────
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

  function assertDelegationAllows(mechanism: Mechanism): void {
    const key =
      mechanism === 'offer'
        ? 'promotions_issuance__offers'
        : mechanism === 'coupon'
          ? 'promotions_issuance__coupons'
          : 'promotions_issuance__vouchers';
    if (DELEGATION_MODE_DEFAULTS[key] !== 'open') {
      throw new AppError(
        403,
        ErrorCode.Forbidden,
        `Issuing ${mechanism}s is currently restricted — contact admin to enable.`,
      );
    }
  }

  async function transition(
    retailerId: string,
    promotionId: string,
    to: typeof promotions.$inferSelect.status,
  ) {
    const storeId = await loadOwnStoreIdOrThrow(retailerId);
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
    return updated!;
  }

  // ===== POST /voucher-codes/generate — bulk voucher code generation =====
  app.post(
    '/voucher-codes/generate',
    {
      schema: {
        body: z.object({
          promotionId: z.string(),
          count: z.coerce.number().int().min(1).max(10_000),
          prefix: z.string().trim().max(8).optional(),
        }),
      },
    },
    async (req) => {
      const storeId = await loadOwnStoreIdOrThrow(getAuth(req).sub);

      const promo = await db.query.promotions.findFirst({
        where: and(eq(promotions.id, req.body.promotionId), eq(promotions.storeId, storeId)),
      });
      if (!promo) throw new AppError(404, ErrorCode.NotFound, 'Promotion not found');
      if (promo.mechanism !== 'voucher') {
        throw new AppError(409, ErrorCode.InvalidState, 'Only voucher promotions can have codes generated');
      }

      const codes = generateCodes(req.body.count, req.body.prefix ? req.body.prefix + '-' : '');
      const rows = codes.map((code) => ({
        id: newId(IdPrefix.VoucherCode),
        promotionId: promo.id,
        code,
      }));

      await db.insert(voucherCodes).values(rows);
      return ok({ generated: codes.length, codes });
    },
  );

  // ===== GET /voucher-codes/export — CSV download of all codes for a promo =====
  app.get(
    '/voucher-codes/export',
    {
      schema: {
        querystring: z.object({ promotionId: z.string() }),
      },
    },
    async (req, reply) => {
      const storeId = await loadOwnStoreIdOrThrow(getAuth(req).sub);

      const promo = await db.query.promotions.findFirst({
        where: and(eq(promotions.id, req.query.promotionId), eq(promotions.storeId, storeId)),
      });
      if (!promo) throw new AppError(404, ErrorCode.NotFound, 'Promotion not found');

      const allCodes = await db.query.voucherCodes.findMany({
        where: eq(voucherCodes.promotionId, promo.id),
        orderBy: (t, { asc }) => [asc(t.createdAt)],
      });

      const lines = ['code,redeemed_count,total_uses'];
      for (const c of allCodes) {
        lines.push(`${c.code},${c.redeemedCount},${c.totalUses ?? ''}`);
      }

      void reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="vouchers-${promo.id}.csv"`)
        .send(lines.join('\n'));
      return reply;
    },
  );

  // ===== GET /promotions/performance — per-promotion redemption metrics for this store =====
  app.get('/performance', async (req) => {
    const auth = getAuth(req);
    const retailer = await db.query.retailerAccounts.findFirst({ where: eq(retailerAccounts.id, auth.sub) });
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
        gmvInfluencePaise: sum(promotionRedemptions.amountAppliedPaise),
      })
      .from(promotionRedemptions)
      .where(inArray(promotionRedemptions.promotionId, promoIds))
      .groupBy(promotionRedemptions.promotionId);

    const statsMap = new Map(stats.map((s) => [s.promotionId, s]));
    const promoMap = new Map(storePromos.map((p) => [p.id, p.name]));

    return ok(
      promoIds.map((id) => {
        const s = statsMap.get(id);
        return {
          promotionId: id,
          name: promoMap.get(id) ?? id,
          redemptions: Number(s?.redemptions ?? 0),
          gmvInfluencePaise: Number(s?.gmvInfluencePaise ?? 0),
          aovLiftBp: 0,
          refundRateBp: 0,
          anomalyFlagged: false,
        };
      }),
    );
  });
};

export default retailerPromotionRoutes;
