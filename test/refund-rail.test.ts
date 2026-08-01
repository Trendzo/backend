/**
 * Pure unit tests for the two decisions that used to be buried inside a single
 * `if (razorpayActive && ref.startsWith('pay_'))` — the branch that quietly fabricated
 * a "succeeded" refund for every COD order.
 *
 * No database, no environment stubbing: both functions take every input explicitly,
 * which is exactly what makes the truth table testable at all.
 */
import { describe, expect, it } from 'vitest';
import { decideRefundStatus, leavesOf } from '@/shared/refunds/rollup.js';
import { resolveTenderDestination } from '@/shared/refunds/resolve-destination.js';
import { simulatedMoneyAllowed } from '@/shared/payments/simulation-guard.js';

const base = {
  channel: 'return' as const,
  handover: null,
  gatewayActive: true,
  simulationAllowed: false,
};

describe('resolveTenderDestination — no production path may fabricate a settlement', () => {
  it('a real capture with a live gateway refunds through the gateway', () => {
    const rail = resolveTenderDestination({
      ...base,
      sourceGatewayRef: 'pay_ABC123',
      sourcePaymentMethod: 'upi',
    });
    expect(rail).toEqual({ destination: 'original_tender', mode: 'gateway' });
  });

  it('a COD return with cash already handed binds to that handover', () => {
    const rail = resolveTenderDestination({
      ...base,
      sourceGatewayRef: 'COD-abc123',
      sourcePaymentMethod: 'cod',
      handover: { id: 'rch_1', availablePaise: 30_000 },
    });
    expect(rail).toEqual({ destination: 'cash', handoverId: 'rch_1', amountPaise: 30_000 });
  });

  it('a COD return with no handover yet is cash, still owed', () => {
    const rail = resolveTenderDestination({
      ...base,
      sourceGatewayRef: 'COUNTER-abc123',
      sourcePaymentMethod: 'cod',
    });
    expect(rail).toMatchObject({ destination: 'cash', handoverId: null });
  });

  it('a COD CANCELLATION has no collection visit, so it parks on the payout desk', () => {
    const rail = resolveTenderDestination({
      ...base,
      channel: 'cancellation',
      sourceGatewayRef: 'COD-abc123',
      sourcePaymentMethod: 'cod',
    });
    expect(rail.destination).toBe('manual_payout');
  });

  it('a simulated ref settles simulated ONLY when simulation is allowed', () => {
    const dev = resolveTenderDestination({
      ...base,
      simulationAllowed: true,
      sourceGatewayRef: 'MOCK-abc123',
      sourcePaymentMethod: 'card',
    });
    expect(dev).toEqual({ destination: 'original_tender', mode: 'simulated' });
  });

  /** THE regression: this is the exact combination that used to fake a success. */
  it('a simulated ref in production is refused a rail and parks on the desk', () => {
    const prod = resolveTenderDestination({
      ...base,
      simulationAllowed: false,
      sourceGatewayRef: 'TEST-abc123',
      sourcePaymentMethod: 'card',
    });
    expect(prod.destination).toBe('manual_payout');
  });

  it('a prepaid ref with the gateway deconfigured in production parks on the desk', () => {
    const prod = resolveTenderDestination({
      ...base,
      gatewayActive: false,
      simulationAllowed: false,
      sourceGatewayRef: 'pay_ABC123',
      sourcePaymentMethod: 'upi',
    });
    expect(prod.destination).toBe('manual_payout');
  });
});

describe('decideRefundStatus — derived from the LEAF disbursements', () => {
  const leg = (
    id: string,
    status: 'pending' | 'succeeded' | 'failed',
    previousDisbursementId: string | null = null,
  ) => ({ id, status, previousDisbursementId });

  it('no legs yet → pending', () => {
    expect(decideRefundStatus([])).toBe('pending');
  });

  it('every leaf succeeded → succeeded', () => {
    expect(decideRefundStatus([leg('a', 'succeeded'), leg('b', 'succeeded')])).toBe('succeeded');
  });

  it('every leaf failed → failed (NOT partially_disbursed — nothing landed)', () => {
    expect(decideRefundStatus([leg('a', 'failed')])).toBe('failed');
  });

  it('some landed, some outstanding → partially_disbursed', () => {
    expect(decideRefundStatus([leg('a', 'succeeded'), leg('b', 'pending')])).toBe(
      'partially_disbursed',
    );
  });

  it('nothing landed but something is in flight → processing', () => {
    expect(decideRefundStatus([leg('a', 'pending'), leg('b', 'failed')])).toBe('processing');
  });

  it('a failed leg superseded by a pending retry is NOT a leaf', () => {
    const legs = [leg('a', 'failed'), leg('b', 'pending', 'a')];
    expect(leavesOf(legs).map((l) => l.id)).toEqual(['b']);
    // Without the leaf filter this would read 'partially_disbursed' or 'failed' forever,
    // even after the retry succeeded.
    expect(decideRefundStatus(legs)).toBe('processing');
  });

  it('a failed leg superseded by a SUCCEEDED retry reads succeeded', () => {
    expect(decideRefundStatus([leg('a', 'failed'), leg('b', 'succeeded', 'a')])).toBe('succeeded');
  });
});

describe('simulation guard', () => {
  /**
   * The suite blanks the Razorpay env on purpose so the mock gateway drives every money
   * path. Gating the production hardening on NODE_ENV rather than on isRazorpayActive()
   * is exactly what keeps that working — this asserts we did not disable ourselves.
   */
  it('simulated money is allowed under NODE_ENV=test', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(simulatedMoneyAllowed()).toBe(true);
  });
});
