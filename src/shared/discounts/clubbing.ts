import type { AppliedTo, ClubbingDefaultValue } from '../promotions/schemas.js';
import type { ClubbingRule, EvaluatedPromotion } from './types.js';

/**
 * Canonical pairing — matches the DB CHECK `clubbing_matrix_canonical_order`. The matrix
 * stores each pair only once, in enum-declared order, so lookups must canonicalise too.
 */
const APPLIED_TO_ORDER: Readonly<AppliedTo[]> = [
  'retailer_promo',
  'platform_promo',
  'coupon',
  'shipping',
  'loyalty',
];
function ordinal(a: AppliedTo): number {
  return APPLIED_TO_ORDER.indexOf(a);
}
function canonicalPair(a: AppliedTo, b: AppliedTo): [AppliedTo, AppliedTo] {
  return ordinal(a) <= ordinal(b) ? [a, b] : [b, a];
}

/**
 * Look up the matrix value for the (a, b) pair. Returns 'allowed' for unseeded pairs —
 * matrix is the exception list, default is permissive (per plan note).
 */
function matrixValue(rules: ClubbingRule[], a: AppliedTo, b: AppliedTo): ClubbingDefaultValue {
  const [x, y] = canonicalPair(a, b);
  const hit = rules.find((r) => r.appliedToA === x && r.appliedToB === y);
  return hit?.defaultValue ?? 'allowed';
}

/**
 * Decide whether two evaluated promotions can co-exist. Order of precedence:
 *  1. `always_allowed` matrix value cannot be overridden (locked combination).
 *  2. Either side's `nonStackable` array containing the other's id → blocked.
 *  3. Either side's `stackableWith` containing the other's id → allowed (overrides
 *     a `disallowed` matrix default).
 *  4. Otherwise the matrix value wins.
 */
function compatible(
  a: EvaluatedPromotion,
  b: EvaluatedPromotion,
  rules: ClubbingRule[],
): boolean {
  const matrixDefault = matrixValue(rules, a.promotion.appliedTo, b.promotion.appliedTo);
  if (matrixDefault === 'always_allowed') return true;

  const aBlocksB = a.promotion.nonStackable.includes(b.promotion.id);
  const bBlocksA = b.promotion.nonStackable.includes(a.promotion.id);
  if (aBlocksB || bBlocksA) return false;

  const aAllowsB = a.promotion.stackableWith.includes(b.promotion.id);
  const bAllowsA = b.promotion.stackableWith.includes(a.promotion.id);
  if (aAllowsB || bAllowsA) return true;

  return matrixDefault === 'allowed';
}

/**
 * Resolve maximum-discount conflict-free subset of evaluated promotions.
 *
 * Algorithm: greedy by descending discount amount. Each candidate is added to the kept
 * set only if it's compatible with every promo already kept. With at most ~10 candidates
 * per checkout in practice, an O(n²) check is fine.
 *
 * Returns the kept subset and the rejected promos with a clubbing-conflict reason.
 */
export function resolveClubbing(
  evaluated: EvaluatedPromotion[],
  rules: ClubbingRule[],
): {
  kept: EvaluatedPromotion[];
  rejected: Array<{ promotion: EvaluatedPromotion; reason: string }>;
} {
  // Only consider promos that actually contribute discount.
  const sorted = evaluated
    .filter((e) => e.amountPaise > 0)
    .sort((a, b) => b.amountPaise - a.amountPaise);

  const kept: EvaluatedPromotion[] = [];
  const rejected: Array<{ promotion: EvaluatedPromotion; reason: string }> = [];

  for (const cand of sorted) {
    const conflict = kept.find((k) => !compatible(k, cand, rules));
    if (conflict) {
      rejected.push({
        promotion: cand,
        reason: `clubbing_blocked_with:${conflict.promotion.id}`,
      });
    } else {
      kept.push(cand);
    }
  }

  return { kept, rejected };
}
