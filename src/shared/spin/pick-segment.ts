/**
 * Weighted slice draw for Spin & Win.
 *
 * This lives on the server for a reason. The app used to hold the weights and pick its own
 * winner (`SpinWinPopup.tsx` built a weighted bag and called `Math.random()`), which meant
 * the odds shipped in the bundle for anyone to read and nothing stopped a patched client
 * from landing on the jackpot every time. Now the client is told an index and animates to
 * it; weights never leave this process.
 *
 * `randomInt` from node:crypto, not `Math.random()` — same choice as
 * `shared/promotions/voucher-codes.ts`, and the reason is the same: this decides who gets
 * money.
 */
import { randomInt } from 'node:crypto';

export type DrawableSegment = {
  id: string;
  weightBp: number;
  stockTotal: number | null;
  stockIssued: number;
};

/** True when the slice has a global cap and has already paid it out. */
export function isExhausted(s: Pick<DrawableSegment, 'stockTotal' | 'stockIssued'>): boolean {
  return s.stockTotal !== null && s.stockIssued >= s.stockTotal;
}

/**
 * Pick one segment, honouring `weightBp` and skipping slices whose global stock is spent.
 *
 * Exhausted slices are *removed from the bag* rather than re-rolled: their probability mass
 * spreads across whatever is left, in proportion. A wheel whose jackpot has run out keeps
 * paying out its other slices at the right relative odds instead of quietly biasing toward
 * whichever slice happens to be checked first.
 *
 * Returns null when nothing is drawable (every slice exhausted, or all weights zero) — the
 * caller turns that into "the wheel is out of prizes" rather than picking arbitrarily.
 */
export function pickSegment<T extends DrawableSegment>(segments: readonly T[]): T | null {
  const eligible = segments.filter((s) => !isExhausted(s) && s.weightBp > 0);
  if (eligible.length === 0) return null;

  const total = eligible.reduce((sum, s) => sum + s.weightBp, 0);
  if (total <= 0) return null;

  // randomInt's upper bound is exclusive, so this is a uniform draw over [0, total).
  let roll = randomInt(0, total);
  for (const s of eligible) {
    roll -= s.weightBp;
    if (roll < 0) return s;
  }
  // Unreachable while the loop subtracts exactly `total`, but returning the last eligible
  // slice is the safe degenerate answer if that ever stops being true.
  return eligible[eligible.length - 1] ?? null;
}
