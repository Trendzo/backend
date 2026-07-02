import { describe, expect, it } from 'vitest';
import { compute, type ComputeInput } from './compute.js';
import type { Cart, EngineConfig, EnginePromotion } from './types.js';

const CONFIG: EngineConfig = {
  loyalty: { pointValuePaise: 100, earnRateBp: 10000, minRedeemablePoints: 100, maxRedeemFractionBp: 10000 },
  baseDeliveryFee: { express: 9900, standard: 4900, pickup: 0, try_and_buy: 9900 },
  surgeMultiplier: 1.0,
  tcsRateBp: 100,
};

// Two lines: ₹1000 + ₹2000, GST 5%.
const baseCart = (overrides: Partial<Cart> = {}): Cart => ({
  consumerId: 'c1',
  consumerStateCode: 'MH',
  storeStateCode: 'MH',
  deliveryMethod: 'standard',
  paymentMethod: 'upi',
  lines: [
    { lineId: 'l1', listingId: 'lst1', variantId: 'v1', unitPricePaise: 100000, qty: 1, gstRatePct: 5 },
    { lineId: 'l2', listingId: 'lst2', variantId: 'v2', unitPricePaise: 200000, qty: 1, gstRatePct: 5 },
  ],
  ...overrides,
});

const run = (over: Partial<ComputeInput> = {}) =>
  compute({ cart: baseCart(), promotions: [], clubbingMatrix: [], config: CONFIG, ...over });

describe('pricing engine (pure)', () => {
  it('prices a clean intra-state order: subtotal + CGST/SGST + standard delivery', () => {
    const b = run();
    expect(b.lineSubtotalPaise).toBe(300000);
    expect(b.couponDiscountPaise).toBe(0);
    expect(b.taxBasePaise).toBe(300000);
    expect(b.cgstPaise + b.sgstPaise).toBe(15000); // 5% of 300000
    expect(b.igstPaise).toBe(0); // intra-state
    expect(b.deliveryFeePaise).toBe(4900);
    expect(b.totalPaise).toBe(300000 + 15000 + 4900);
    // Earn rate default = 1 pt per ₹1 of tax base → 3000 pts.
    expect(b.loyaltyEarnedPoints).toBe(3000);
  });

  it('splits tax as IGST inter-state', () => {
    const b = compute({ cart: baseCart({ consumerStateCode: 'KA' }), promotions: [], clubbingMatrix: [], config: CONFIG });
    expect(b.igstPaise).toBe(15000);
    expect(b.cgstPaise).toBe(0);
    expect(b.sgstPaise).toBe(0);
  });

  it('applies a flat-amount coupon before tax', () => {
    const coupon: EnginePromotion = {
      id: 'p1', mechanism: 'coupon', discountType: 'flat_amount', appliedTo: 'coupon',
      config: { amountPaise: 50000 }, scope: {}, stackableWith: [], nonStackable: [],
    };
    const b = run({ promotions: [coupon] });
    expect(b.couponDiscountPaise).toBe(50000);
    expect(b.taxBasePaise).toBe(250000);
    expect(b.cgstPaise + b.sgstPaise).toBe(12500); // 5% of 250000
    expect(b.totalPaise).toBe(250000 + 12500 + 4900);
    expect(b.loyaltyEarnedPoints).toBe(2500);
  });

  it('honours a store delivery-fee override', () => {
    const b = compute({ cart: baseCart(), promotions: [], clubbingMatrix: [], config: { ...CONFIG, deliveryOverridePaise: 0 } });
    expect(b.deliveryFeePaise).toBe(0);
  });
});
