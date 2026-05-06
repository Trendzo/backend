import { eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import {
  loyaltyTransactions,
  platformConfig,
  promotions,
  voucherCodes,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { requireAuth } from '@/shared/auth/middleware.js';
import { compute } from '@/shared/discounts/compute.js';
import type { Cart, EngineConfig, EnginePromotion } from '@/shared/discounts/types.js';
import type {
  AppliedTo,
  ClubbingDefaultValue,
  DiscountType,
  Mechanism,
  PromotionConfig,
  Scope,
} from '@/shared/promotions/schemas.js';

/**
 * POST /admin/promotions/simulate
 *
 * Run the pricing engine against a hypothetical cart. Caller specifies the cart, the
 * promotions to consider (by id), optional coupon code + voucher code (each resolves
 * to a promotion id, server-side), and optional loyalty redemption.
 *
 * Returns the full PricingBreakdown — same shape Phase 7 checkout will return.
 */

const CartLineInput = z.object({
  lineId: z.string().min(1),
  listingId: z.string().min(1),
  variantId: z.string().min(1),
  brandId: z.string().optional(),
  categoryId: z.string().optional(),
  unitPricePaise: z.number().int().positive(),
  qty: z.number().int().positive(),
  gstRatePct: z.number().min(0).max(28).default(5),
});

const CartInput = z.object({
  consumerId: z.string().default('sim-consumer'),
  consumerStateCode: z.string().regex(/^\d{2}$/).default('27'),
  storeStateCode: z.string().regex(/^\d{2}$/).default('27'),
  deliveryMethod: z.enum(['express', 'standard', 'pickup', 'try_and_buy']).default('standard'),
  paymentMethod: z.enum(['upi', 'card', 'cod', 'wallet', 'gift_card']).default('upi'),
  lines: z.array(CartLineInput).min(1),
});

const SimulateSchema = z.object({
  cart: CartInput,
  /** Promotion IDs to apply (typically auto-applied 'offer' mechanism). */
  promotionIds: z.array(z.string()).default([]),
  /** Coupon code typed in by the consumer. */
  couponCode: z.string().trim().optional(),
  /** Voucher code typed in by the consumer (single-use). */
  voucherCode: z.string().trim().optional(),
  /** Loyalty points the consumer wants to spend. */
  pointsToRedeem: z.number().int().nonnegative().default(0),
  /** Override the consumer's loyalty balance (default = compute from DB ledger). */
  consumerLoyaltyBalance: z.number().int().nonnegative().optional(),
  /** Optional retailer-set fees (used in checkout flow when known per-store). */
  deliveryOverridePaise: z.number().int().nonnegative().optional(),
  handlingFeePaise: z.number().int().nonnegative().optional(),
  convenienceFeePaise: z.number().int().nonnegative().optional(),
});

const adminSimulateRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.post('/promotions/simulate', { schema: { body: SimulateSchema } }, async (req) => {
    const cart: Cart = req.body.cart as Cart;

    // Resolve all candidate promotions. Promotion-id list, plus the coupon/voucher
    // codes (which resolve to their underlying promotion).
    const ids = new Set<string>(req.body.promotionIds);
    let voucherCodeId: string | undefined;
    let couponPromoId: string | undefined;

    if (req.body.couponCode) {
      // For coupons, the code IS the promotion's `name` for MVP purposes; we look up
      // by name OR (more robustly) check voucher_codes — coupons may also be entered
      // via the voucher_codes table when distributed to specific consumers. Simple
      // path: look it up by exact name match on a coupon-mechanism promo.
      const promo = await db.query.promotions.findFirst({
        where: eq(promotions.name, req.body.couponCode),
      });
      if (!promo || promo.mechanism !== 'coupon') {
        throw new AppError(404, ErrorCode.CouponInvalid, `No coupon "${req.body.couponCode}" found`);
      }
      ids.add(promo.id);
      couponPromoId = promo.id;
    }

    if (req.body.voucherCode) {
      const code = await db.query.voucherCodes.findFirst({
        where: eq(voucherCodes.code, req.body.voucherCode.toUpperCase()),
      });
      if (!code) {
        throw new AppError(404, ErrorCode.CouponInvalid, `Voucher code not found`);
      }
      if (code.totalUses != null && code.redeemedCount >= code.totalUses) {
        throw new AppError(409, ErrorCode.VoucherAlreadyRedeemed, 'Voucher already redeemed');
      }
      ids.add(code.promotionId);
      voucherCodeId = code.id;
    }

    if (ids.size === 0) {
      // Empty promo list still produces a valid breakdown (just no discounts).
    }

    const promoRows =
      ids.size === 0
        ? []
        : await db.query.promotions.findMany({
            where: inArray(promotions.id, [...ids]),
          });

    const enginePromos: EnginePromotion[] = promoRows.map((p) => ({
      id: p.id,
      mechanism: p.mechanism as Mechanism,
      discountType: p.discountType as DiscountType,
      appliedTo: p.appliedTo as AppliedTo,
      config: p.config as unknown as PromotionConfig,
      scope: p.scope as unknown as Scope,
      stackableWith: p.stackableWith,
      nonStackable: p.nonStackable,
      ...(voucherCodeId && p.id === couponPromoId ? {} : {}),
      ...(voucherCodeId && p.id === promoRows.find((r) => r.id === couponPromoId)?.id
        ? { voucherCodeId }
        : {}),
    }));

    // Tag the voucher's underlying promo with the resolved code id (for the audit log).
    if (voucherCodeId) {
      const voucherCode = await db.query.voucherCodes.findFirst({
        where: eq(voucherCodes.id, voucherCodeId),
      });
      const target = enginePromos.find((p) => p.id === voucherCode?.promotionId);
      if (target) target.voucherCodeId = voucherCodeId;
    }

    // Load the clubbing matrix (raw rows; engine handles canonicalisation).
    const clubbingRows = await db.query.clubbingMatrixEntries.findMany();
    const clubbingMatrix = clubbingRows.map((r) => ({
      appliedToA: r.appliedToA as AppliedTo,
      appliedToB: r.appliedToB as AppliedTo,
      defaultValue: r.defaultValue as ClubbingDefaultValue,
    }));

    // Load engine config from platform_config.
    const engineConfig = await loadEngineConfig(req.body);

    // Look up consumer loyalty balance if not overridden.
    let consumerLoyaltyBalance = req.body.consumerLoyaltyBalance;
    if (consumerLoyaltyBalance === undefined && cart.consumerId !== 'sim-consumer') {
      const last = await db.query.loyaltyTransactions.findFirst({
        where: eq(loyaltyTransactions.consumerId, cart.consumerId),
        orderBy: (t, { desc }) => desc(t.at),
      });
      consumerLoyaltyBalance = last?.balanceAfterPoints ?? 0;
    }

    const breakdown = compute({
      cart,
      promotions: enginePromos,
      clubbingMatrix,
      config: engineConfig,
      pointsToRedeem: req.body.pointsToRedeem,
      consumerLoyaltyBalance: consumerLoyaltyBalance ?? 0,
    });

    return ok(breakdown);
  });
};

async function loadEngineConfig(
  body: z.infer<typeof SimulateSchema>,
): Promise<EngineConfig> {
  const keys = [
    'loyalty_point_value_paise',
    'loyalty_earn_rate_bp',
    'min_redeemable_points',
    'max_redeem_fraction_bp',
    'base_delivery_fee_table',
    'surge_multiplier',
    'tcs_rate_bp',
  ];
  const rows = await db.query.platformConfig.findMany({
    where: inArray(platformConfig.key, keys),
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    loyalty: {
      pointValuePaise: (map.get('loyalty_point_value_paise') as number) ?? 100,
      earnRateBp: (map.get('loyalty_earn_rate_bp') as number) ?? 10000,
      minRedeemablePoints: (map.get('min_redeemable_points') as number) ?? 100,
      maxRedeemFractionBp: (map.get('max_redeem_fraction_bp') as number) ?? 10000,
    },
    baseDeliveryFee:
      (map.get('base_delivery_fee_table') as EngineConfig['baseDeliveryFee']) ??
      { express: 9900, standard: 4900, pickup: 0, try_and_buy: 9900 },
    surgeMultiplier: (map.get('surge_multiplier') as number) ?? 1.0,
    tcsRateBp: (map.get('tcs_rate_bp') as number) ?? 100,
    ...(body.deliveryOverridePaise !== undefined && {
      deliveryOverridePaise: body.deliveryOverridePaise,
    }),
    ...(body.handlingFeePaise !== undefined && { handlingFeePaise: body.handlingFeePaise }),
    ...(body.convenienceFeePaise !== undefined && {
      convenienceFeePaise: body.convenienceFeePaise,
    }),
  };
}

export default adminSimulateRoutes;
