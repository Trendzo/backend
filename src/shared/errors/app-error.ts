/**
 * Stable error codes used in the API envelope. Matches the table in PRODUCT_SPEC §Error Codes
 * and BACKEND_SPEC §11.
 */
export const ErrorCode = {
  // Auth
  Unauthorized: 'unauthorized',
  Forbidden: 'forbidden',
  NotFound: 'not_found',
  InvalidCredentials: 'invalid_credentials',
  EmailAlreadyTaken: 'email_already_taken',

  // Validation
  ValidationError: 'validation_error',
  RateLimited: 'rate_limited',
  InternalError: 'internal_error',

  // Onboarding
  KycInvalid: 'kyc_invalid',
  RetailerNotApproved: 'retailer_not_approved',
  StoreNotActive: 'store_not_active',
  StoreAlreadyExists: 'store_already_exists',
  NotOwner: 'not_owner',
  InvalidState: 'invalid_state',
  SkuTaken: 'sku_taken',

  // Catalog publish gates
  CannotPublishIncomplete: 'cannot_publish_incomplete',

  // Domain
  OutOfStock: 'out_of_stock',
  StorePaused: 'store_paused',
  PaymentFailed: 'payment_failed',

  // Promotion
  CouponInvalid: 'coupon_invalid',
  CouponExpired: 'coupon_expired',
  CouponExhausted: 'coupon_exhausted',
  CouponNotEligible: 'coupon_not_eligible',
  CouponMinOrderNotMet: 'coupon_min_order_not_met',
  CouponAlreadyUsed: 'coupon_already_used',
  CouponClubbingBlocked: 'coupon_clubbing_blocked',
  VoucherAlreadyRedeemed: 'voucher_already_redeemed',

  // Wallet / Loyalty
  InsufficientWalletBalance: 'insufficient_wallet_balance',
  InsufficientPoints: 'insufficient_points',
  BelowMinimum: 'below_minimum',
  ExceedsBalance: 'exceeds_balance',
  ExceedsCap: 'exceeds_cap',

  // Gift cards
  GiftCardInvalid: 'gift_card_invalid',
  GiftCardExpired: 'gift_card_expired',
  GiftCardAlreadyRedeemed: 'gift_card_already_redeemed',

  // Idempotency
  AlreadyClaimed: 'already_claimed',
  AlreadySpun: 'already_spun',
  AlreadyEntered: 'already_entered',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Domain error. Throw this from handlers; the error middleware translates it into the
 * `{ success: false, error: { code, message } }` envelope.
 */
export class AppError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: ErrorCodeValue,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static unauthorized(message = 'Unauthorized'): AppError {
    return new AppError(401, ErrorCode.Unauthorized, message);
  }
  static forbidden(message = 'Forbidden'): AppError {
    return new AppError(403, ErrorCode.Forbidden, message);
  }
  static notFound(message = 'Not found'): AppError {
    return new AppError(404, ErrorCode.NotFound, message);
  }
  static validation(message: string, details?: unknown): AppError {
    return new AppError(422, ErrorCode.ValidationError, message, details);
  }
  static conflict(code: ErrorCodeValue, message: string): AppError {
    return new AppError(409, code, message);
  }
  static internal(message = 'Internal server error'): AppError {
    return new AppError(500, ErrorCode.InternalError, message);
  }
}
