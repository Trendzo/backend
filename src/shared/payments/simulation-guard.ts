/**
 * Simulated money movement is a DEV/TEST affordance. It must never happen in production.
 *
 * Two paths used to fall into a fabricated success purely because the gateway was
 * inactive: a consumer card/UPI charge at placement (`isMockCardCharge`) and a refund
 * disbursement whose source ref was not a `pay_…` id (every COD refund). Both were
 * gated on `isRazorpayActive()` alone, so a production deploy with the Razorpay env
 * unset shipped orders for free and told customers their COD refund was complete.
 *
 * The gate is `NODE_ENV`, deliberately — NOT `isRazorpayActive()`. The test suite
 * blanks the Razorpay env on purpose (`vitest.config.ts`) so the mock gateway drives
 * every money path; gating on the gateway would have disabled the whole suite.
 *
 * Mirrors the existing prod-only precedent in `razorpay.ts`, where a missing webhook
 * secret fails closed in production and is skipped in dev/test.
 */
import { env } from '@/config/env.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { notifyAllAdmins } from '@/shared/notify-admins.js';

export function simulatedMoneyAllowed(): boolean {
  return env.NODE_ENV !== 'production';
}

/**
 * Fail closed, loudly, at any point where a simulated settlement WOULD have happened.
 * No-op outside production.
 */
export function assertNoSimulatedMoney(context: string): void {
  if (simulatedMoneyAllowed()) return;
  console.error(`[money-guard] simulated settlement blocked in production: ${context}`);
  void notifyAllAdmins({
    kind: 'system',
    title: 'Simulated money movement blocked in production',
    body: context,
  }).catch(() => undefined);
  throw new AppError(
    503,
    ErrorCode.PaymentFailed,
    'Payment processing is temporarily unavailable. Please try again shortly.',
  );
}
