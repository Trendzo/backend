import { describe, expect, it } from 'vitest';
import { categoryDefaultHsn, GstRateBp, resolveGstRateBp } from './gst-rates.js';
import {
  PARENT_BY_LEAF_SLUG,
  TAXONOMY,
  leafSlug,
  parentSlug,
} from '@/shared/catalog/taxonomy.js';

const rate = (hsn: string | null, categorySlug: string | null, mrpRupees: number) =>
  resolveGstRateBp({ hsn, categorySlug, unitMrpPaise: mrpRupees * 100 });

describe('resolveGstRateBp — GST 2.0 (eff 22-Sep-2025)', () => {
  describe('apparel price slab (≤ ₹2,500 → 5%, > ₹2,500 → 18%)', () => {
    it('cheap apparel is 5%', () => {
      expect(rate(null, 'tops-tshirts', 999)).toBe(GstRateBp.reduced);
      expect(rate(null, 'tops-tshirts', 2500)).toBe(GstRateBp.reduced); // boundary inclusive
    });
    it('premium apparel is 18%', () => {
      expect(rate(null, 'bottoms-trousers', 2501)).toBe(GstRateBp.standard);
      expect(rate(null, 'dresses-maxi', 5000)).toBe(GstRateBp.standard);
    });
    it('the old ₹1,000/12% slab is gone — a ₹1,500 tee is 5%, not 12%', () => {
      expect(rate(null, 'tops-tshirts', 1500)).toBe(GstRateBp.reduced);
      expect(rate(null, 'tops-tshirts', 1500)).not.toBe(GstRateBp.imitation_jewellery);
    });
    it('classifies an unknown leaf by its parent, not by substring luck', () => {
      // `denim-jeans` contains none of the old shirt/dress/bottom/top probes.
      expect(rate(null, 'denim-jeans', 1200)).toBe(GstRateBp.reduced);
      expect(rate(null, 'denim-jeans', 4000)).toBe(GstRateBp.standard);
    });
  });

  describe('footwear price slab (same ₹2,500 cutoff, HSN 6403)', () => {
    it('cheap footwear is 5%', () => {
      expect(rate(null, 'shoes-sneakers', 2000)).toBe(GstRateBp.reduced);
      expect(rate('6403', null, 2000)).toBe(GstRateBp.reduced);
    });
    it('premium footwear is 18%', () => {
      expect(rate(null, 'shoes-heels', 4000)).toBe(GstRateBp.standard);
    });
    it('still resolves the retired flat slug from an old order snapshot', () => {
      expect(rate(null, 'footwear', 2000)).toBe(GstRateBp.reduced);
    });
  });

  describe('cosmetics — flat 18%, no price slab', () => {
    it('a cheap lipstick is 18%, not 5%', () => {
      expect(rate(null, 'beauty-makeup', 800)).toBe(GstRateBp.standard);
      expect(rate('3304', null, 800)).toBe(GstRateBp.standard);
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
      expect(rate(null, 'accessories-belts', 1200)).toBe(GstRateBp.standard);
      expect(rate(null, 'bags-totes', 1200)).toBe(GstRateBp.standard);
    });
    it('socks / tights / scarves are textiles, so they price-slab despite sitting under Accessories', () => {
      expect(rate(null, 'accessories-socks', 400)).toBe(GstRateBp.reduced);
      expect(rate(null, 'accessories-scarves', 400)).toBe(GstRateBp.reduced);
    });
    it('imitation jewellery leaves resolve to 12% without an explicit HSN', () => {
      expect(rate(categoryDefaultHsn('jewelry-earrings'), 'jewelry-earrings', 800)).toBe(
        GstRateBp.imitation_jewellery,
      );
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
  it('maps taxonomy parents', () => {
    expect(categoryDefaultHsn('shoes')).toBe('6403');
    expect(categoryDefaultHsn('accessories')).toBe('4202');
    expect(categoryDefaultHsn('tops')).toBe('6109');
    expect(categoryDefaultHsn('dresses')).toBe('6204');
  });
  it('inherits the parent default for leaves that have no override', () => {
    expect(categoryDefaultHsn('tops-tshirts')).toBe('6109');
    expect(categoryDefaultHsn('bottoms-chinos')).toBe('6203');
    expect(categoryDefaultHsn('denim-jeans')).toBe('6203');
    expect(categoryDefaultHsn('dresses-maxi')).toBe('6204');
    expect(categoryDefaultHsn('shoes-sneakers')).toBe('6403');
  });
  it('applies leaf overrides where the parent default is wrong', () => {
    expect(categoryDefaultHsn('tops-shirts')).toBe('6205'); // woven, not knitted
    expect(categoryDefaultHsn('accessories-sunglasses')).toBe('9004');
    expect(categoryDefaultHsn('accessories-watches')).toBe('9102');
    expect(categoryDefaultHsn('bottoms-skirts')).toBe('6204');
    expect(categoryDefaultHsn('beauty-fragrance')).toBe('3303');
  });
  it('still resolves retired flat slugs from pre-taxonomy snapshots', () => {
    expect(categoryDefaultHsn('footwear')).toBe('6403');
    expect(categoryDefaultHsn('apparel')).toBe('6109');
  });
  it('returns null for no category', () => {
    expect(categoryDefaultHsn(null)).toBeNull();
  });
});

/**
 * `parentOf` used to strip the last `-segment`, which is only correct for single-word
 * leaf keys. Nineteen leaves resolved to a non-existent parent and fell through to the
 * knitwear default 6109 — every multi-word leaf under coords, active, swim and ethnic,
 * plus wide-leg and lounge-pants.
 */
describe('multi-word leaf slugs resolve to their real parent', () => {
  it('gives multi-word leaves their parent HSN, not the generic default', () => {
    expect(categoryDefaultHsn('coords-two-piece')).toBe('6204');
    expect(categoryDefaultHsn('coords-skirt-sets')).toBe('6204');
    expect(categoryDefaultHsn('bottoms-wide-leg')).toBe('6203');
    expect(categoryDefaultHsn('denim-wide-leg')).toBe('6203');
    expect(categoryDefaultHsn('active-sports-bras')).toBe('6112');
    expect(categoryDefaultHsn('active-track-pants')).toBe('6112');
    expect(categoryDefaultHsn('swim-beach-shirts')).toBe('6112');
    expect(categoryDefaultHsn('lounge-lounge-pants')).toBe('6208');
    expect(categoryDefaultHsn('ethnic-kurta-sets')).toBe('6205');
    expect(categoryDefaultHsn('ethnic-nehru-jackets')).toBe('6205');
  });

  it('resolves every leaf in the taxonomy to a real parent', () => {
    for (const p of TAXONOMY) {
      for (const l of p.leaves) {
        expect(PARENT_BY_LEAF_SLUG[leafSlug(p, l.key)]).toBe(parentSlug(p));
      }
    }
  });

  it('still resolves single-word leaves and legacy flat slugs', () => {
    expect(categoryDefaultHsn('shoes-sneakers')).toBe('6403');
    expect(categoryDefaultHsn('bags-totes')).toBe('4202');
    // Retired flat slug from an old order snapshot — the one-segment strip is the
    // only guess available, and it must still land on footwear.
    expect(categoryDefaultHsn('footwear')).toBe('6403');
  });

  it('accepts the old gender-prefixed slugs historical rows still carry', () => {
    expect(categoryDefaultHsn('her-coords-two-piece')).toBe('6204');
    expect(categoryDefaultHsn('him-ethnic-kurtas')).toBe('6205');
    expect(categoryDefaultHsn('her-jewelry-earrings')).toBe('7117');
  });
});
