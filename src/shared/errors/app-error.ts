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
  ApplicationPending: 'application_pending',
  ApplicationRejected: 'application_rejected',
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
  IdempotencyConflict: 'idempotency_conflict',

  // Orders
  OrderNotFound: 'order_not_found',
  OrderTransitionInvalid: 'order_transition_invalid',
  OrderStockUnavailable: 'order_stock_unavailable',
  OrderStoreUnavailable: 'order_store_unavailable',
  OrderRetryBudgetExhausted: 'order_retry_budget_exhausted',
  OrderCancellationNotAllowed: 'order_cancellation_not_allowed',

  // Door visit (Try-and-Buy)
  DoorVisitInvalidItem: 'door_visit_invalid_item',
  DoorVisitMustChooseAllItems: 'door_visit_must_choose_all_items',
  DoorVisitExtensionExhausted: 'door_visit_extension_exhausted',
  DoorVisitRefuseRequiresEvidence: 'door_visit_refuse_requires_evidence',

  // Returns
  ReturnNotFound: 'return_not_found',
  ReturnWindowExpired: 'return_window_expired',
  ReturnInvalidState: 'return_invalid_state',
  ReturnAlreadyDecided: 'return_already_decided',

  // Refunds
  RefundNotFound: 'refund_not_found',
  DisbursementNotFound: 'disbursement_not_found',
  DisbursementAlreadyTerminal: 'disbursement_already_terminal',

  // Held items
  HeldItemNotFound: 'held_item_not_found',
  HeldItemNotHolding: 'held_item_not_holding',
  HeldExtensionAlreadyUsed: 'held_extension_already_used',

  // Disputes
  DisputeNotFound: 'dispute_not_found',
  DisputeInvalidState: 'dispute_invalid_state',
  DisputeAlreadyDecided: 'dispute_already_decided',
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
