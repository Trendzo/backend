/**
 * Zod schemas for promotion config + scope/eligibility, plus the enum unions used at API
 * boundaries. The pricing engine consumes the parsed types directly. The API layer picks
 * the right config schema based on `discountType`.
 *
 * `promotions.config` and `promotions.scope` are JSONB blobs; we Zod-validate on every
 * read/write boundary so the JSONB doesn't carry malformed shapes.
 */
import { z } from 'zod';

// ─────────────── Enums (mirror src/db/schema/enums.ts) ───────────────

export const MechanismEnum = z.enum(['offer', 'coupon', 'voucher']);
export type Mechanism = z.infer<typeof MechanismEnum>;

export const DiscountTypeEnum = z.enum([
  'flat_amount',
  'percent',
  'percent_upto',
  'bogo',
  'bxgy',
  'bundle',
  'tiered_cart',
  'free_shipping',
]);
export type DiscountType = z.infer<typeof DiscountTypeEnum>;

export const IssuerTypeEnum = z.enum(['admin', 'retailer', 'system']);
export type IssuerType = z.infer<typeof IssuerTypeEnum>;

export const AppliedToEnum = z.enum([
  'retailer_promo',
  'platform_promo',
  'coupon',
  'shipping',
  'loyalty',
]);
export type AppliedTo = z.infer<typeof AppliedToEnum>;

export const PromotionStatusEnum = z.enum([
  'draft',
  'scheduled',
  'active',
  'paused',
  'expired',
  'exhausted',
  'revoked',
]);
export type PromotionStatusValue = z.infer<typeof PromotionStatusEnum>;

export const ClubbingDefaultEnum = z.enum(['allowed', 'disallowed', 'always_allowed']);
export type ClubbingDefaultValue = z.infer<typeof ClubbingDefaultEnum>;

export const DeliveryMethodEnum = z.enum(['express', 'standard', 'pickup', 'try_and_buy']);
export const PaymentMethodEnum = z.enum(['upi', 'card', 'cod', 'wallet', 'gift_card']);

// ─────────────── Config schemas (one per discountType) ───────────────

export const FlatAmountConfig = z.object({
  /** ₹ off, in paise. Cap is applied at compute-time so it never exceeds line subtotal. */
  amountPaise: z.number().int().positive(),
});
export type FlatAmountConfig = z.infer<typeof FlatAmountConfig>;

export const PercentConfig = z.object({
  /** 0 < percent ≤ 100. */
  percent: z.number().positive().max(100),
});
export type PercentConfig = z.infer<typeof PercentConfig>;

export const PercentUptoConfig = z.object({
  percent: z.number().positive().max(100),
  /** Hard ceiling on the discount amount (paise). */
  maxAmountPaise: z.number().int().positive(),
});
export type PercentUptoConfig = z.infer<typeof PercentUptoConfig>;

export const BogoConfig = z.object({
  /** Listing the customer must buy. */
  buyListingId: z.string().min(1),
  /** Listing they get discounted. Omit = same as buyListingId (true BOGO). */
  getListingId: z.string().min(1).optional(),
  /** 0 = full price (no discount), 100 = free. Use 100 for true BOGO. */
  discountPercent: z.number().min(0).max(100).default(100),
});
export type BogoConfig = z.infer<typeof BogoConfig>;

export const BxgyConfig = z.object({
  buyQty: z.number().int().positive(),
  getQty: z.number().int().positive(),
  buyListingIds: z.array(z.string()).min(1),
  /** Omit = same as buyListingIds (e.g. buy 2 of X, get 1 X free). */
  getListingIds: z.array(z.string()).min(1).optional(),
  /** Discount on the cheapest `getQty` items in `getListingIds`. 100 = free. */
  discountPercent: z.number().min(0).max(100).default(100),
});
export type BxgyConfig = z.infer<typeof BxgyConfig>;

export const BundleConfig = z.object({
  /** Cart must include at least one of each. */
  bundleListingIds: z.array(z.string().min(1)).min(2),
  /** Discount applied to the bundle's combined subtotal. */
  discountPercent: z.number().positive().max(100),
});
export type BundleConfig = z.infer<typeof BundleConfig>;

export const TieredCartTier = z.object({
  /** Minimum cart subtotal (paise) for this tier to apply. */
  minCartPaise: z.number().int().nonnegative(),
  /** Percent off when this tier applies. */
  discountPercent: z.number().positive().max(100),
});
export const TieredCartConfig = z.object({
  /** Engine picks the tier with the largest `minCartPaise` ≤ cart subtotal. */
  tiers: z.array(TieredCartTier).min(1),
});
export type TieredCartConfig = z.infer<typeof TieredCartConfig>;

export const FreeShippingConfig = z.object({
  /** Optional cap — promo applies only if cart subtotal ≥ this. */
  minCartPaise: z.number().int().nonnegative().optional(),
});
export type FreeShippingConfig = z.infer<typeof FreeShippingConfig>;

/**
 * Map of discountType → its config schema. The handler picks the right one based on
 * the `discountType` value in the request body.
 */
export const ConfigByDiscountType = {
  flat_amount: FlatAmountConfig,
  percent: PercentConfig,
  percent_upto: PercentUptoConfig,
  bogo: BogoConfig,
  bxgy: BxgyConfig,
  bundle: BundleConfig,
  tiered_cart: TieredCartConfig,
  free_shipping: FreeShippingConfig,
} as const;

export type PromotionConfig =
  | FlatAmountConfig
  | PercentConfig
  | PercentUptoConfig
  | BogoConfig
  | BxgyConfig
  | BundleConfig
  | TieredCartConfig
  | FreeShippingConfig;

// ─────────────── Scope + eligibility ───────────────

const TimeOfDay = z.string().regex(/^\d{2}:\d{2}$/, 'HH:MM');
const TimeWindow = z.object({ from: TimeOfDay, to: TimeOfDay });

/**
 * Combined targeting + eligibility filters, stored in `promotions.scope` JSONB.
 * Targeting = what the discount applies to (which products).
 * Eligibility = when/who can use it.
 */
export const ScopeSchema = z
  .object({
    // Targeting
    listingIds: z.array(z.string()).optional(),
    categoryIds: z.array(z.string()).optional(),
    brandIds: z.array(z.string()).optional(),
    storeIds: z.array(z.string()).optional(),
    excludeListingIds: z.array(z.string()).optional(),
    excludeCategoryIds: z.array(z.string()).optional(),
    excludeBrandIds: z.array(z.string()).optional(),
    // Time eligibility
    allowedDaysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
    allowedTimesOfDay: z.array(TimeWindow).optional(),
    // Cart eligibility
    minCartPaise: z.number().int().nonnegative().optional(),
    minItemCount: z.number().int().positive().optional(),
    // Order eligibility
    allowedDeliveryMethods: z.array(DeliveryMethodEnum).optional(),
    allowedPaymentMethods: z.array(PaymentMethodEnum).optional(),
    // Region eligibility
    allowedStateCodes: z.array(z.string().length(2)).optional(), // e.g. ["MH", "KA"]
    // Shopper eligibility
    firstOrderOnly: z.boolean().optional(),
    loyaltyTierFilter: z.array(z.enum(['bronze', 'silver', 'gold', 'platinum'])).optional(),
    specificConsumerIds: z.array(z.string()).optional(),
    excludeConsumerIds: z.array(z.string()).optional(),
  })
  .default({});
export type Scope = z.infer<typeof ScopeSchema>;

// ─────────────── Promotion create / update body schemas ───────────────

/**
 * Common fields on every promotion create/edit request — independent of discountType.
 * The handler validates `config` separately against `ConfigByDiscountType[discountType]`.
 */
export const PromotionCommonSchema = z.object({
  name: z.string().trim().min(1).max(160),
  mechanism: MechanismEnum,
  discountType: DiscountTypeEnum,
  /**
   * `appliedTo` classifies the promotion for the clubbing matrix.
   * Sensible defaults can be derived from mechanism+issuer; the handler will fill if absent.
   */
  appliedTo: AppliedToEnum.optional(),
  /** Free-form JSONB carrying the discount parameters; validated against the right schema. */
  config: z.record(z.string(), z.unknown()),
  scope: ScopeSchema.optional(),
  stackableWith: z.array(z.string()).default([]),
  nonStackable: z.array(z.string()).default([]),
  totalUses: z.number().int().nonnegative().nullable().optional(),
  perConsumerLimit: z.number().int().nonnegative().nullable().optional(),
  validFrom: z.coerce.date(),
  validUntil: z.coerce.date(),
  /** Authoring decision: save as `draft` or push `scheduled`/`active`. */
  status: z.enum(['draft', 'scheduled', 'active']).optional(),
});
export type PromotionCommon = z.infer<typeof PromotionCommonSchema>;

/** Patch — every field optional except no mechanism/discountType change after creation. */
export const PromotionPatchSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  appliedTo: AppliedToEnum.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  scope: ScopeSchema.optional(),
  stackableWith: z.array(z.string()).optional(),
  nonStackable: z.array(z.string()).optional(),
  totalUses: z.number().int().nonnegative().nullable().optional(),
  perConsumerLimit: z.number().int().nonnegative().nullable().optional(),
  validFrom: z.coerce.date().optional(),
  validUntil: z.coerce.date().optional(),
});
export type PromotionPatch = z.infer<typeof PromotionPatchSchema>;

/**
 * Validate the `config` field against the schema for the given discountType.
 * Throws ZodError on mismatch — the API layer translates that to a 422.
 */
export function validateConfigForDiscountType(
  discountType: DiscountType,
  config: unknown,
): PromotionConfig {
  return ConfigByDiscountType[discountType].parse(config) as PromotionConfig;
}

/**
 * Sensible default for `appliedTo` based on mechanism + issuer:
 *  - coupon → 'coupon'
 *  - voucher → 'coupon' (vouchers route through the coupon clubbing slot)
 *  - offer + admin → 'platform_promo'
 *  - offer + retailer → 'retailer_promo'
 *  - free_shipping always overrides → 'shipping'
 *  - system → mirrors offer's behaviour
 */
export function defaultAppliedTo(
  mechanism: Mechanism,
  issuer: IssuerType,
  discountType: DiscountType,
): AppliedTo {
  if (discountType === 'free_shipping') return 'shipping';
  if (mechanism === 'coupon' || mechanism === 'voucher') return 'coupon';
  // offer
  return issuer === 'retailer' ? 'retailer_promo' : 'platform_promo';
}
