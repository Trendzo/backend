import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import { promotions, retailerAccounts } from '@/db/schema/index.js';
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
        }),
      },
    },
    async (req) => {
      const storeId = await loadOwnStoreIdOrThrow(getAuth(req).sub);
      const conds = [eq(promotions.storeId, storeId)];
      if (req.query.status) conds.push(eq(promotions.status, req.query.status));
      if (req.query.mechanism) conds.push(eq(promotions.mechanism, req.query.mechanism));

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
};

export default retailerPromotionRoutes;
