import { describe, expect, it } from 'vitest';
import { categoryDefaultHsn, GstRateBp, resolveGstRateBp } from './gst-rates.js';

const rate = (hsn: string | null, categorySlug: string | null, mrpRupees: number) =>
  resolveGstRateBp({ hsn, categorySlug, unitMrpPaise: mrpRupees * 100 });

describe('resolveGstRateBp — GST 2.0 (eff 22-Sep-2025)', () => {
  describe('apparel price slab (≤ ₹2,500 → 5%, > ₹2,500 → 18%)', () => {
    it('cheap apparel is 5%', () => {
      expect(rate(null, 'apparel', 999)).toBe(GstRateBp.reduced);
      expect(rate(null, 'him-tshirts', 2500)).toBe(GstRateBp.reduced); // boundary inclusive
    });
    it('premium apparel is 18%', () => {
      expect(rate(null, 'apparel', 2501)).toBe(GstRateBp.standard);
      expect(rate(null, 'her-dresses', 5000)).toBe(GstRateBp.standard);
    });
    it('the old ₹1,000/12% slab is gone — a ₹1,500 tee is 5%, not 12%', () => {
      expect(rate(null, 'apparel', 1500)).toBe(GstRateBp.reduced);
      expect(rate(null, 'apparel', 1500)).not.toBe(GstRateBp.imitation_jewellery);
    });
  });

  describe('footwear price slab (same ₹2,500 cutoff, HSN 6403)', () => {
    it('cheap footwear is 5%', () => {
      expect(rate(null, 'footwear', 2000)).toBe(GstRateBp.reduced);
      expect(rate('6403', null, 2000)).toBe(GstRateBp.reduced);
    });
    it('premium footwear is 18%', () => {
      expect(rate(null, 'footwear', 4000)).toBe(GstRateBp.standard);
    });
  });

  describe('accessories — flat by type, NOT price-slab', () => {
    it('bags / belts / wallets (4202/4203) → 18% regardless of price', () => {
      expect(rate('4202', 'accessories', 500)).toBe(GstRateBp.standard);
      expect(rate('4203', 'accessories', 9000)).toBe(GstRateBp.standard);
    });
    it('sunglasses (9004) → 18%', () => {
      expect(rate('9004', 'accessories', 1500)).toBe(GstRateBp.standard);
    });
    it('imitation jewellery (7117) → 12%', () => {
      expect(rate('7117', 'accessories', 800)).toBe(GstRateBp.imitation_jewellery);
    });
    it('fine jewellery (7113) → 3%', () => {
      expect(rate('7113', 'accessories', 50000)).toBe(GstRateBp.fine_jewellery);
    });
    it('accessory with no HSN defaults to 18%', () => {
      expect(rate(null, 'accessories', 1200)).toBe(GstRateBp.standard);
    });
  });

  describe('HSN wins over category when recognisable', () => {
    it('a 6109 apparel HSN on an unknown category still price-slabs', () => {
      expect(rate('6109', null, 999)).toBe(GstRateBp.reduced);
      expect(rate('6109', null, 3000)).toBe(GstRateBp.standard);
    });
    it('falls back to apparel slab when neither HSN nor category is usable', () => {
      expect(rate(null, null, 999)).toBe(GstRateBp.reduced);
    });
  });
});

describe('categoryDefaultHsn', () => {
  it('maps the core categories', () => {
    expect(categoryDefaultHsn('footwear')).toBe('6403');
    expect(categoryDefaultHsn('accessories')).toBe('4202');
    expect(categoryDefaultHsn('apparel')).toBe('6109');
  });
  it('maps garment sub-categories', () => {
    expect(categoryDefaultHsn('her-dresses')).toBe('6204');
    expect(categoryDefaultHsn('him-bottoms')).toBe('6203');
    expect(categoryDefaultHsn('him-shirts')).toBe('6205');
    expect(categoryDefaultHsn('him-tshirts')).toBe('6109');
  });
  it('returns null for no category', () => {
    expect(categoryDefaultHsn(null)).toBeNull();
  });
});
