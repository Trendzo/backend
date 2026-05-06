/**
 * Default clubbing rules. Mirrors PRODUCT_SPEC §"Clubbing Matrix" exactly. The pricing
 * engine reads these to decide whether two promotions can be applied together; per-promotion
 * `stackableWith` / `nonStackable` arrays override these defaults, EXCEPT for rows marked
 * `always_allowed`, which cannot be overridden.
 *
 * Pairs are stored in canonical order — alphabetical on `applied_to` value — to keep
 * the lookup deterministic regardless of which promotion is the "left" or "right".
 */

import { randomUUID } from 'node:crypto';
import type { db as Db } from '@/db/client.js';
import { clubbingMatrixEntries } from '@/db/schema/index.js';

type ClubbingDefault = 'allowed' | 'disallowed' | 'always_allowed';
type AppliedTo = 'retailer_promo' | 'platform_promo' | 'coupon' | 'shipping' | 'loyalty';

type Entry = {
  appliedToA: AppliedTo;
  appliedToB: AppliedTo;
  defaultValue: ClubbingDefault;
  note: string;
};

// MUST match the declaration order of the `promotion_applied_to` pgEnum in enums.ts —
// Postgres compares enum values by their declared ordinal, not alphabetically. The DB
// CHECK constraint `clubbing_matrix_canonical_order` enforces
// `applied_to_a <= applied_to_b` using this ordering.
const APPLIED_TO_ENUM_ORDER: readonly AppliedTo[] = [
  'retailer_promo',
  'platform_promo',
  'coupon',
  'shipping',
  'loyalty',
];

function canonicalisePair(a: AppliedTo, b: AppliedTo): readonly [AppliedTo, AppliedTo] {
  const ai = APPLIED_TO_ENUM_ORDER.indexOf(a);
  const bi = APPLIED_TO_ENUM_ORDER.indexOf(b);
  return ai <= bi ? [a, b] : [b, a];
}

// Spec table uses (offer, coupon, voucher) mechanism names; our enum models the broader
// `applied_to` classification. Mapping below uses retailer_promo/platform_promo for offers,
// coupon for coupon codes, and shipping/loyalty for the always-allowed pair.
export const CLUBBING_MATRIX_DEFAULTS: readonly Entry[] = [
  {
    appliedToA: 'platform_promo',
    appliedToB: 'platform_promo',
    defaultValue: 'allowed',
    note: 'Multiple platform offers may stack',
  },
  {
    appliedToA: 'platform_promo',
    appliedToB: 'retailer_promo',
    defaultValue: 'allowed',
    note: 'Platform offer + retailer offer: allowed',
  },
  {
    appliedToA: 'coupon',
    appliedToB: 'platform_promo',
    defaultValue: 'allowed',
    note: 'Coupon + platform offer: allowed',
  },
  {
    appliedToA: 'coupon',
    appliedToB: 'retailer_promo',
    defaultValue: 'allowed',
    note: 'Coupon + retailer offer: allowed',
  },
  {
    appliedToA: 'coupon',
    appliedToB: 'coupon',
    defaultValue: 'disallowed',
    note: 'Two coupons in the same order: disallowed',
  },
  {
    appliedToA: 'retailer_promo',
    appliedToB: 'retailer_promo',
    defaultValue: 'allowed',
    note: 'Two retailer offers may stack',
  },
  {
    appliedToA: 'shipping',
    appliedToB: 'coupon',
    defaultValue: 'always_allowed',
    note: 'Free shipping is always combinable',
  },
  {
    appliedToA: 'loyalty',
    appliedToB: 'coupon',
    defaultValue: 'always_allowed',
    note: 'Loyalty redemption is always combinable',
  },
  {
    appliedToA: 'loyalty',
    appliedToB: 'platform_promo',
    defaultValue: 'always_allowed',
    note: 'Loyalty redemption is always combinable',
  },
  {
    appliedToA: 'loyalty',
    appliedToB: 'retailer_promo',
    defaultValue: 'always_allowed',
    note: 'Loyalty redemption is always combinable',
  },
];

export async function seedClubbingMatrix(db: typeof Db): Promise<void> {
  for (const entry of CLUBBING_MATRIX_DEFAULTS) {
    const [a, b] = canonicalisePair(entry.appliedToA, entry.appliedToB);
    await db
      .insert(clubbingMatrixEntries)
      .values({
        id: randomUUID(),
        appliedToA: a,
        appliedToB: b,
        defaultValue: entry.defaultValue,
        note: entry.note,
      })
      .onConflictDoNothing();
  }
}
