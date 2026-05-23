/**
 * Per-variant "effective consumer price" preview for the retailer pricing dashboard.
 *
 * Wraps the pricing engine with retailer-context assumptions: qty=1, standard delivery,
 * UPI, single-state (so the breakdown is GST-included but does not split inter-state).
 * Only auto-applied 'offer' promotions are considered — coupons and vouchers require
 * explicit consumer input and have no fixed value to a retailer.
 */
import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import {
  clubbingMatrixEntries,
  platformConfig,
  productListings,
  promotions,
  retailerStores,
  variants,
} from '@/db/schema/index.js';
import { compute } from './compute.js';
import type {
  AppliedTo,
  ClubbingDefaultValue,
  DiscountType,
  Mechanism,
  PromotionConfig,
} from '../promotions/schemas.js';
import type {
  Cart,
  CartLine,
  ClubbingRule,
  EngineConfig,
  EnginePromotion,
  PricingBreakdown,
} from './types.js';

export type VariantEffectivePrice = {
  variantId: string;
  attributesLabel: string;
  basePaise: number;
  postPromoSubtotalPaise: number;
  effectivePaise: number;
  totalDiscountPaise: number;
  appliedPromos: Array<{
    promotionId: string;
    name: string;
    appliedTo: AppliedTo;
    discountType: DiscountType;
    amountPaise: number;
  }>;
};

const DEFAULT_GST_PCT = 5;

export async function previewListingEffectivePricing(
  database: typeof Db,
  storeId: string,
  listingId: string,
): Promise<VariantEffectivePrice[]> {
  const listing = await database.query.productListings.findFirst({
    where: eq(productListings.id, listingId),
  });
  if (!listing) return [];

  const store = await database.query.retailerStores.findFirst({
    where: eq(retailerStores.id, storeId),
  });
  if (!store) return [];

  const variantRows = await database.query.variants.findMany({
    where: eq(variants.listingId, listingId),
  });
  if (variantRows.length === 0) return [];

  const now = new Date();
  const promoRows = await database.query.promotions.findMany({
    where: and(
      eq(promotions.mechanism, 'offer'),
      eq(promotions.status, 'active'),
      lte(promotions.validFrom, now),
      gte(promotions.validUntil, now),
      // Either platform-wide (storeId IS NULL) or scoped to this store.
      or(isNull(promotions.storeId), eq(promotions.storeId, storeId)),
    ),
  });

  const enginePromos: EnginePromotion[] = promoRows.map((p) => ({
    id: p.id,
    mechanism: p.mechanism as Mechanism,
    discountType: p.discountType as DiscountType,
    appliedTo: p.appliedTo as AppliedTo,
    config: p.config as unknown as PromotionConfig,
    scope: p.scope as unknown as EnginePromotion['scope'],
    stackableWith: p.stackableWith,
    nonStackable: p.nonStackable,
  }));
  const promoNameById = new Map(promoRows.map((p) => [p.id, p.name]));

  const clubbingRows = await database.query.clubbingMatrixEntries.findMany();
  const clubbingMatrix: ClubbingRule[] = clubbingRows.map((r) => ({
    appliedToA: r.appliedToA as AppliedTo,
    appliedToB: r.appliedToB as AppliedTo,
    defaultValue: r.defaultValue as ClubbingDefaultValue,
  }));

  const engineConfig = await loadPreviewEngineConfig(database, store);

  return variantRows.map((v) => {
    const line: CartLine = {
      lineId: v.id,
      listingId: listing.id,
      variantId: v.id,
      ...(listing.brandId ? { brandId: listing.brandId } : {}),
      ...(listing.categoryId ? { categoryId: listing.categoryId } : {}),
      unitPricePaise: v.pricePaise,
      qty: 1,
      gstRatePct: DEFAULT_GST_PCT,
    };
    const cart: Cart = {
      consumerId: 'pricing-preview',
      consumerStateCode: store.stateCode,
      storeStateCode: store.stateCode,
      deliveryMethod: 'standard',
      paymentMethod: 'upi',
      lines: [line],
    };
    const breakdown: PricingBreakdown = compute({
      cart,
      promotions: enginePromos,
      clubbingMatrix,
      config: engineConfig,
      pointsToRedeem: 0,
      consumerLoyaltyBalance: 0,
    });
    const totalPromoPaise =
      breakdown.retailerPromoDiscountPaise + breakdown.platformPromoDiscountPaise;
    return {
      variantId: v.id,
      attributesLabel: v.attributesLabel,
      basePaise: breakdown.lineSubtotalPaise,
      postPromoSubtotalPaise: breakdown.postPromoSubtotalPaise,
      effectivePaise: breakdown.postPromoSubtotalPaise,
      totalDiscountPaise: totalPromoPaise,
      appliedPromos: breakdown.appliedPromotions
        .filter(
          (p) => p.appliedTo === 'retailer_promo' || p.appliedTo === 'platform_promo',
        )
        .map((p) => ({
          promotionId: p.promotionId,
          name: promoNameById.get(p.promotionId) ?? p.promotionId,
          appliedTo: p.appliedTo,
          discountType: p.discountType,
          amountPaise: p.amountPaise,
        })),
    };
  });
}

async function loadPreviewEngineConfig(
  database: typeof Db,
  store: typeof retailerStores.$inferSelect,
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
  const rows = await database.query.platformConfig.findMany({
    where: inArray(platformConfig.key, keys),
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const cfg: EngineConfig = {
    loyalty: {
      pointValuePaise: (map.get('loyalty_point_value_paise') as number) ?? 100,
      earnRateBp: (map.get('loyalty_earn_rate_bp') as number) ?? 10000,
      minRedeemablePoints: (map.get('min_redeemable_points') as number) ?? 100,
      maxRedeemFractionBp: (map.get('max_redeem_fraction_bp') as number) ?? 10000,
    },
    baseDeliveryFee:
      (map.get('base_delivery_fee_table') as EngineConfig['baseDeliveryFee']) ?? {
        express: 9900,
        standard: 4900,
        pickup: 0,
        try_and_buy: 9900,
      },
    surgeMultiplier: (map.get('surge_multiplier') as number) ?? 1.0,
    tcsRateBp: (map.get('tcs_rate_bp') as number) ?? 100,
  };
  if (store.deliveryOverridePaise !== null) {
    cfg.deliveryOverridePaise = store.deliveryOverridePaise;
  }
  if (store.handlingFeePaise !== null) {
    cfg.handlingFeePaise = store.handlingFeePaise;
  }
  if (store.convenienceFeePaise !== null) {
    cfg.convenienceFeePaise = store.convenienceFeePaise;
  }
  void clubbingMatrixEntries;
  void sql;
  return cfg;
}
