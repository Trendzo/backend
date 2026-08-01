/**
 * Which rail does this refund's non-wallet portion travel on?
 *
 * The decision used to be made at SETTLEMENT time, inside `settleTenderDisbursement`,
 * as a single `if (razorpayActive && ref.startsWith('pay_'))`. Everything that failed
 * that test — every COD refund, every mock-gateway ref, in production as much as in
 * dev — fell off the end into a fabricated success: status 'succeeded', a made-up
 * `REFUND-TEST-…` reference, and not one rupee moved.
 *
 * Now the rail is decided when the disbursement ROW IS WRITTEN, so the settler only
 * ever sees legs it can actually settle, and a leg that has no rail is born `pending`
 * on a desk instead of silently completing.
 *
 * Pure function: every input is injected (nothing read from `env` or the DB) so the
 * whole truth table is unit-testable without a database or environment stubbing.
 */
import { isCodPaymentRef, isRazorpayPaymentRef } from '@/shared/payments/razorpay.js';

export type TenderRail =
  /** Real gateway refund, or the dev/test simulation of one. */
  | { destination: 'original_tender'; mode: 'gateway' | 'simulated' }
  /** Physical cash. `handoverId` non-null ⇒ the cash is ALREADY handed; born succeeded. */
  | { destination: 'cash'; handoverId: string | null; amountPaise: number }
  /** No automatic rail exists. Born pending on the admin payout desk. */
  | { destination: 'manual_payout'; reason: string };

export type ResolveDestinationInput = {
  sourceGatewayRef: string | null;
  sourcePaymentMethod: 'upi' | 'card' | 'cod' | 'wallet' | 'gift_card';
  /** Which lifecycle raised the refund — decides whether a cash channel exists at all. */
  channel: 'return' | 'cancellation';
  /** Unclaimed cash already handed for these returns, if any. */
  handover: { id: string; availablePaise: number } | null;
  gatewayActive: boolean;
  /** `env.NODE_ENV !== 'production'`, injected. */
  simulationAllowed: boolean;
};

export function resolveTenderDestination(input: ResolveDestinationInput): TenderRail {
  // 1. The happy path: a real capture we can reverse through the gateway.
  if (input.gatewayActive && isRazorpayPaymentRef(input.sourceGatewayRef)) {
    return { destination: 'original_tender', mode: 'gateway' };
  }

  const isCod =
    input.sourcePaymentMethod === 'cod' || isCodPaymentRef(input.sourceGatewayRef);

  if (isCod) {
    // 2/3. A return has a cash channel — the driver collecting the goods, or the
    // counter. If the cash is already in the customer's hand, bind to that handover.
    if (input.channel === 'return') {
      if (input.handover && input.handover.availablePaise > 0) {
        return {
          destination: 'cash',
          handoverId: input.handover.id,
          amountPaise: input.handover.availablePaise,
        };
      }
      return { destination: 'cash', handoverId: null, amountPaise: 0 };
    }
    // 4. A cancellation has nobody visiting the customer, so no cash channel exists.
    return {
      destination: 'manual_payout',
      reason: 'COD order cancelled — no collection visit to hand cash back on',
    };
  }

  // 5. Mock/legacy prepaid refs. Dev and test only.
  if (input.simulationAllowed) {
    return { destination: 'original_tender', mode: 'simulated' };
  }

  // 6. Production, and no rail can carry this. Park it — never fabricate a success.
  return {
    destination: 'manual_payout',
    reason: input.gatewayActive
      ? `Unrefundable source reference '${input.sourceGatewayRef ?? 'none'}'`
      : 'Payment gateway is not configured — cannot issue an automatic refund',
  };
}
