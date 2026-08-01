/**
 * The consumer's delivery OTP — one implementation, one policy.
 *
 * This check used to live only inside the driver deliveries controller, so the
 * retailer's `mark-delivered` route (and its door-close twin) could push an order to
 * `delivered` with an empty request body and no proof of handover at all. Every path
 * that claims goods reached the customer now calls the same assertion.
 *
 * The reverse-pickup COLLECT OTP is deliberately separate — different secret,
 * different door, different actor.
 */
import { env } from '@/config/env.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';

/**
 * QA backdoor: accepted as the consumer delivery OTP so QA can deliver without the
 * real code. Gated to non-production — in production the real crypto OTP is the ONLY
 * accepted value.
 */
export const TEST_DELIVERY_OTP = '1111';
const ALLOW_TEST_OTP = env.NODE_ENV !== 'production';

export function deliveryOtpAccepted(
  orderOtp: string | null,
  submitted: string | undefined,
): boolean {
  if (!orderOtp) return true; // legacy orders minted before delivery OTPs existed
  if (submitted === orderOtp) return true;
  return ALLOW_TEST_OTP && submitted === TEST_DELIVERY_OTP;
}

/**
 * Throw 403 unless the submitted OTP proves handover. Returns whether a real OTP was
 * actually verified, so the caller can record `otpVerified:false` on the legacy rows
 * that carry no OTP and audit can find them later.
 */
export function assertDeliveryOtp(
  order: { deliveryOtp: string | null },
  submitted: string | undefined,
): boolean {
  if (!deliveryOtpAccepted(order.deliveryOtp, submitted)) {
    throw new AppError(403, ErrorCode.ValidationError, 'Invalid delivery OTP');
  }
  return order.deliveryOtp !== null;
}
