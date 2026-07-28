import { describe, expect, it } from 'vitest';
import { isExhausted, pickSegment, type DrawableSegment } from './pick-segment.js';

const seg = (
  id: string,
  weightBp: number,
  stockTotal: number | null = null,
  stockIssued = 0,
): DrawableSegment => ({ id, weightBp, stockTotal, stockIssued });

describe('isExhausted', () => {
  it('is false when the slice has no global cap', () => {
    expect(isExhausted(seg('a', 100, null, 9999))).toBe(false);
  });
  it('is true only once issued reaches the cap', () => {
    expect(isExhausted(seg('a', 100, 5, 4))).toBe(false);
    expect(isExhausted(seg('a', 100, 5, 5))).toBe(true);
  });
});

describe('pickSegment', () => {
  it('returns null when there is nothing drawable', () => {
    expect(pickSegment([])).toBeNull();
    expect(pickSegment([seg('a', 0)])).toBeNull(); // zero weight
    expect(pickSegment([seg('a', 100, 1, 1)])).toBeNull(); // exhausted
  });

  it('always returns the only eligible slice', () => {
    const only = seg('win', 10000);
    for (let i = 0; i < 50; i++) expect(pickSegment([only, seg('dead', 0)])?.id).toBe('win');
  });

  it('never returns an exhausted slice', () => {
    const segments = [seg('jackpot', 9900, 3, 3), seg('consolation', 100)];
    for (let i = 0; i < 500; i++) {
      expect(pickSegment(segments)?.id).toBe('consolation');
    }
  });

  it('honours the weights within sampling tolerance', () => {
    // 20% / 80% split. Over 20k draws the 3-sigma band on the 20% arm is about +-0.85pp,
    // so a 3pp tolerance is loose enough never to flake and tight enough to catch a
    // genuinely broken distribution (e.g. uniform-over-slices would land at 50%).
    const segments = [seg('rare', 2000), seg('common', 8000)];
    const N = 20_000;
    let rare = 0;
    for (let i = 0; i < N; i++) if (pickSegment(segments)!.id === 'rare') rare++;
    expect(rare / N).toBeGreaterThan(0.17);
    expect(rare / N).toBeLessThan(0.23);
  });

  it('redistributes an exhausted slice’s odds in proportion, not to whoever is first', () => {
    // Jackpot (50%) is spent. The remaining 10/40 must renormalise to 20/80 — if the
    // implementation re-rolled or fell through to "first eligible", this would skew.
    const segments = [seg('jackpot', 5000, 1, 1), seg('rare', 1000), seg('common', 4000)];
    const N = 20_000;
    let rare = 0;
    for (let i = 0; i < N; i++) {
      const got = pickSegment(segments)!;
      expect(got.id).not.toBe('jackpot');
      if (got.id === 'rare') rare++;
    }
    expect(rare / N).toBeGreaterThan(0.17);
    expect(rare / N).toBeLessThan(0.23);
  });

  it('can reach every eligible slice, including the last one', () => {
    // Guards the boundary arithmetic in the subtract-until-negative loop: an off-by-one
    // there typically starves either the first or the last slice.
    const segments = [seg('a', 3333), seg('b', 3333), seg('c', 3334)];
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(pickSegment(segments)!.id);
    expect(seen).toEqual(new Set(['a', 'b', 'c']));
  });
});
