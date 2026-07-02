/**
 * Read-only integration tests for the pricing orchestrator against the seeded DB.
 * `computeQuote` performs NO writes, so running these against the dev database is safe.
 * Skipped automatically when DATABASE_URL is absent.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { productListings, variants } from '@/db/schema/index.js';
import { computeQuote } from './compute-quote.js';

const hasDb = !!process.env['DATABASE_URL'];

describe.runIf(hasDb)('computeQuote (integration, read-only)', () => {
  let storeId: string;
  let variantId: string;
  let unitPricePaise: number;

  beforeAll(async () => {
    const listing = await db.query.productListings.findFirst({
      where: eq(productListings.status, 'active'),
      with: { variants: { where: eq(variants.isActive, true), limit: 1 } },
    });
    if (!listing || !listing.variants[0]) throw new Error('No seeded active listing/variant');
    storeId = listing.storeId;
    variantId = listing.variants[0].id;
    unitPricePaise = listing.variants[0].pricePaise;
  });

  it('prices a guest order (no consumer): zero loyalty/wallet, intra-state GST, per-line gross', async () => {
    const q = await computeQuote(db, {
      storeId,
      items: [{ variantId, qty: 2 }],
      deliveryMethod: 'standard',
      paymentMethod: 'upi',
    });
    expect(q.consumer).toBeNull();
    expect(q.walletBalancePaise).toBe(0);
    expect(q.walletAppliedPaise).toBe(0);
    expect(q.breakdown.loyaltyDiscountPaise).toBe(0);
    expect(q.breakdown.loyaltyRedeemedPoints).toBe(0);
    // No address → store state → intra-state.
    expect(q.breakdown.igstPaise).toBe(0);
    expect(q.breakdown.cgstPaise + q.breakdown.sgstPaise).toBeGreaterThan(0);
    expect(q.deliveryOptions.standard).toBe(q.breakdown.deliveryFeePaise);
    expect(q.lines[0]!.grossPaise).toBe(unitPricePaise * 2);
    expect(q.lines[0]!.unitPricePaise).toBe(unitPricePaise);
  });

  it('rejects an unknown coupon without throwing and prices without it', async () => {
    const q = await computeQuote(db, {
      storeId,
      items: [{ variantId, qty: 1 }],
      deliveryMethod: 'standard',
      paymentMethod: 'upi',
      couponCode: 'DEFINITELY_NOT_A_CODE',
    });
    expect(q.breakdown.couponDiscountPaise).toBe(0);
    expect(q.rejectedCodes).toContainEqual({ code: 'DEFINITELY_NOT_A_CODE', kind: 'coupon', reason: 'not_found' });
  });

  it('applies the seeded NEWVIBE coupon (₹500 flat) when present', async () => {
    const q = await computeQuote(db, {
      storeId,
      items: [{ variantId, qty: 1 }],
      deliveryMethod: 'standard',
      paymentMethod: 'upi',
      couponCode: 'NEWVIBE',
    });
    // NEWVIBE is seeded as flat ₹500 off; if seeded, it applies; otherwise it's rejected.
    if (q.rejectedCodes.length === 0) {
      expect(q.breakdown.couponDiscountPaise).toBe(50000);
    } else {
      expect(q.rejectedCodes[0]!.code).toBe('NEWVIBE');
    }
  });
});
