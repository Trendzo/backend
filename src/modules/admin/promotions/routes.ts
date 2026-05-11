import { and, count, desc, eq, isNull, or, sum } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import { promotionRedemptions, promotions, retailerStores } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { recordAudit } from '@/shared/audit.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import {
  defaultAppliedTo,
  PromotionCommonSchema,
  PromotionPatchSchema,
  PromotionStatusEnum,
  validateConfigForDiscountType,
} from '@/shared/promotions/schemas.js';
import { canTransitionTo, effectiveStatus } from '@/shared/promotions/lifecycle.js';

/**
 * Admin promotion CRUD. Admins can create promotions of any mechanism / discount type
 * with platform-wide scope OR scoped to a specific store. The runtime status returned
 * to the client is `effectiveStatus(...)` — derived from stored status + dates + counters.
 */
const adminPromotionRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // ============ List ============
  app.get(
    '/',
    {
      schema: {
        querystring: z.object({
          status: PromotionStatusEnum.optional(),
          mechanism: z.enum(['offer', 'coupon', 'voucher']).optional(),
          storeId: z.string().optional(),
          /** When true, includes only platform-wide (storeId IS NULL) promotions. */
          platformOnly: z
            .enum(['true', 'false'])
            .optional()
            .transform((v) => v === 'true'),
        }),
      },
    },
    async (req) => {
      const { status, mechanism, storeId, platformOnly } = req.query;
      const conds = [];
      if (status) conds.push(eq(promotions.status, status));
      if (mechanism) conds.push(eq(promotions.mechanism, mechanism));
      if (storeId) conds.push(eq(promotions.storeId, storeId));
      if (platformOnly) conds.push(isNull(promotions.storeId));

      const where =
        conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);

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
    },
  );

  // ============ Get one ============
  app.get(
    '/:id',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const promo = await loadPromotion(req.params.id);
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

  // ============ Create ============
  app.post(
    '/',
    {
      schema: {
        body: PromotionCommonSchema.extend({
          /** Optional storeId — when set, the promo is scoped to that store. */
          storeId: z.string().optional(),
        }),
      },
    },
    async (req) => {
      const body = req.body;

      // Validate the discount config against the right schema for its discountType.
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

      // If a storeId is set, verify it exists.
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

      // Validate validity window — Zod's z.coerce.date() accepts strings; validUntil > validFrom.
      if (body.validUntil.getTime() <= body.validFrom.getTime()) {
        throw new AppError(
          422,
          ErrorCode.ValidationError,
          'validUntil must be strictly after validFrom',
        );
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
      return ok(created);
    },
  );

  // ============ Patch ============
  app.patch(
    '/:id',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: PromotionPatchSchema,
      },
    },
    async (req) => {
      const promo = await loadPromotion(req.params.id);
      // Terminal states cannot be patched (other than via /resume from paused).
      if (['expired', 'exhausted', 'revoked'].includes(promo.status)) {
        throw new AppError(
          409,
          ErrorCode.InvalidState,
          `Cannot edit a promotion in '${promo.status}'`,
        );
      }

      const body = req.body;
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

      // Validity window invariant
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
  app.post('/:id/pause', { schema: { params: z.object({ id: z.string() }) } }, async (req) => {
    return ok(await transition(req.params.id, 'paused'));
  });
  app.post('/:id/resume', { schema: { params: z.object({ id: z.string() }) } }, async (req) => {
    return ok(await transition(req.params.id, 'active'));
  });
  app.post('/:id/revoke', { schema: { params: z.object({ id: z.string() }) } }, async (req) => {
    return ok(await transition(req.params.id, 'revoked'));
  });
  app.post('/:id/activate', { schema: { params: z.object({ id: z.string() }) } }, async (req) => {
    // 'draft' or 'scheduled' → 'active'.
    return ok(await transition(req.params.id, 'active'));
  });

  /** Loader used by every handler — wraps not-found into AppError. */
  async function loadPromotion(id: string) {
    const promo = await db.query.promotions.findFirst({ where: eq(promotions.id, id) });
    if (!promo) throw new AppError(404, ErrorCode.NotFound, 'Promotion not found');
    return promo;
  }

  /** Apply a state-machine transition (validates legality, updates status). */
  async function transition(id: string, to: typeof promotions.$inferSelect.status) {
    const promo = await loadPromotion(id);
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
      .where(eq(promotions.id, id))
      .returning();
    return updated!;
  }

  // ===== GET /admin/promotions/performance =====
  app.get('/performance', async () => {
    const stats = await db
      .select({
        promotionId: promotionRedemptions.promotionId,
        redemptions: count(),
        gmvInfluencePaise: sum(promotionRedemptions.amountAppliedPaise),
      })
      .from(promotionRedemptions)
      .groupBy(promotionRedemptions.promotionId);

    if (stats.length === 0) return ok([]);

    const promoRows = await db.query.promotions.findMany({
      where: (t, { inArray }) => inArray(t.id, stats.map((s) => s.promotionId)),
    });
    const promoMap = new Map(promoRows.map((p) => [p.id, p.name]));

    return ok(
      stats.map((s) => ({
        promotionId: s.promotionId,
        name: promoMap.get(s.promotionId) ?? s.promotionId,
        redemptions: Number(s.redemptions),
        gmvInfluencePaise: Number(s.gmvInfluencePaise ?? 0),
        aovLiftBp: 0,
        refundRateBp: 0,
        anomalyFlagged: false,
      })),
    );
  });

  // ===== GET /admin/promotions/anomalies — returns empty until anomaly detection lands =====
  app.get('/anomalies', async () => ok([]));
  app.get('/anomalies/:id', { schema: { params: z.object({ id: z.string() }) } }, async (_req) => {
    throw new AppError(404, ErrorCode.NotFound, 'Anomaly not found');
  });

  // ===== GET /admin/promotions/targeted-drops — returns empty until targeted-drops table lands =====
  app.get('/targeted-drops', async () => ok([]));

  // ===== POST /admin/targeted-drops — push promo to consumer cohort (stub) =====
  // MOCK_DEPENDENCY: §14 consumer wallet — actual wallet push deferred
  app.post(
    '/targeted-drops',
    {
      schema: {
        body: z.object({
          promotionId: z.string(),
          cohort: z.enum(['all', 'loyalty_gold', 'loyalty_silver', 'loyalty_bronze', 'specific_consumers']),
          consumerIds: z.array(z.string()).optional(),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const promo = await db.query.promotions.findFirst({
        where: and(
          eq(promotions.id, req.body.promotionId),
          eq(promotions.issuerType, 'admin'),
        ),
      });
      if (!promo) throw new AppError(404, ErrorCode.NotFound, 'Platform promotion not found');

      if (req.body.cohort === 'specific_consumers' && (!req.body.consumerIds || req.body.consumerIds.length === 0)) {
        throw new AppError(400, ErrorCode.ValidationError, 'consumerIds required for specific_consumers cohort');
      }

      await recordAudit({
        actor: auth,
        action: 'promotions.targeted_drop',
        resourceKind: 'promotion',
        resourceId: promo.id,
        requestId: req.id,
      });

      return ok({
        promotionId: promo.id,
        cohort: req.body.cohort,
        consumerCount: req.body.consumerIds?.length ?? null,
        dispatched: true,
      });
    },
  );

  // Suppress unused — kept for future cohort filters.
  void or;
};

export default adminPromotionRoutes;
