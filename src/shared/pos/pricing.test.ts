import { describe, expect, it } from 'vitest';
import { posTaxSplitFor, pricePosSale, type PricingVariant } from './pricing.js';

function variant(over: Partial<PricingVariant> = {}): PricingVariant {
  return {
    variantId: 'v1',
    listingId: 'l1',
    unitMrpPaise: 100000, // ₹1000
    gstRateBp: 500, // 5%
    listingNameSnap: 'Tee',
    brandSnap: null,
    categorySnap: null,
    attributesLabelSnap: 'M',
    hsnSnap: '6109',
    skuSnap: null,
    barcodeSnap: null,
    ...over,
  };
}

describe('posTaxSplitFor — place of supply', () => {
  it('same-state GSTIN → intra_state', () => {
    expect(posTaxSplitFor('27', '27ABCDE1234F1Z5')).toBe('intra_state');
  });
  it('different-state GSTIN → inter_state', () => {
    expect(posTaxSplitFor('27', '29ABCDE1234F1Z5')).toBe('inter_state');
  });
  it('walk-in (no GSTIN) → intra_state', () => {
    expect(posTaxSplitFor('27', null)).toBe('intra_state');
    expect(posTaxSplitFor('27', undefined)).toBe('intra_state');
    expect(posTaxSplitFor('27', '')).toBe('intra_state');
  });
});

describe('pricePosSale — CGST/SGST vs IGST split', () => {
  const args = { variants: [variant()], lines: [{ variantId: 'v1', qty: 1 }] };

  it('intra-state splits CGST+SGST, no IGST', () => {
    const p = pricePosSale({ ...args, taxSplitKind: 'intra_state' });
    expect(p.igstPaise).toBe(0);
    expect(p.cgstPaise + p.sgstPaise).toBe(p.taxPaise);
    expect(p.cgstPaise).toBe(Math.floor(p.taxPaise / 2));
  });

  it('inter-state puts all tax in IGST, no CGST/SGST', () => {
    const p = pricePosSale({ ...args, taxSplitKind: 'inter_state' });
    expect(p.cgstPaise).toBe(0);
    expect(p.sgstPaise).toBe(0);
    expect(p.igstPaise).toBe(p.taxPaise);
  });

  it('total tax is identical regardless of split', () => {
    const intra = pricePosSale({ ...args, taxSplitKind: 'intra_state' });
    const inter = pricePosSale({ ...args, taxSplitKind: 'inter_state' });
    expect(intra.taxPaise).toBe(inter.taxPaise);
    expect(intra.payablePaise).toBe(inter.payablePaise);
  });

  it('defaults to intra_state when unspecified', () => {
    const p = pricePosSale(args);
    expect(p.taxSplitKind).toBe('intra_state');
    expect(p.igstPaise).toBe(0);
  });

  it('tax-inclusive ₹1000 @ 5% back-calcs ~₹47.62 GST', () => {
    const p = pricePosSale(args);
    // 100000 * 500 / 10500 = 4761.9 → rounded
    expect(p.taxPaise).toBe(4762);
    expect(p.taxableValuePaise).toBe(95238);
  });
});
