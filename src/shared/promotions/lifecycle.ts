import type { PromotionStatusValue } from './schemas.js';

/**
 * Promotion lifecycle state machine (PRODUCT_SPEC line 720–729).
 *
 *   draft → scheduled → active → { paused → active, expired, exhausted, revoked }
 *
 * `expired`, `exhausted`, `revoked` are terminal. `paused` is reversible. `draft` is a
 * pre-publication holding state.
 */
const TRANSITIONS: Readonly<Record<PromotionStatusValue, ReadonlyArray<PromotionStatusValue>>> = {
  draft: ['scheduled', 'active', 'revoked'],
  scheduled: ['active', 'paused', 'revoked'],
  active: ['paused', 'expired', 'exhausted', 'revoked'],
  paused: ['active', 'revoked'],
  expired: [],
  exhausted: [],
  revoked: [],
};

export function canTransitionTo(
  from: PromotionStatusValue,
  to: PromotionStatusValue,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Snapshot of the rules a promo write must honour. Pure — pass the relevant fields,
 * get the *effective* runtime status. Useful when the stored `status` column hasn't
 * been touched by a scheduler yet (e.g. a stored 'active' promo whose `validUntil`
 * has passed should *render* as 'expired' to admins).
 */
export function effectiveStatus(
  stored: PromotionStatusValue,
  validFrom: Date,
  validUntil: Date,
  totalUses: number | null,
  redeemedCount: number,
  now: Date = new Date(),
): PromotionStatusValue {
  // Terminal states stay terminal regardless of dates.
  if (stored === 'revoked' || stored === 'expired' || stored === 'exhausted') return stored;
  if (stored === 'paused') return 'paused';
  if (stored === 'draft') return 'draft';

  // Stored is 'scheduled' or 'active' — derive runtime state from time + counters.
  if (totalUses != null && redeemedCount >= totalUses) return 'exhausted';
  if (now.getTime() >= validUntil.getTime()) return 'expired';
  if (now.getTime() < validFrom.getTime()) return 'scheduled';
  return 'active';
}

/** A promo is "live" (eligible to apply to orders) only when effective status is 'active'. */
export function isLive(
  stored: PromotionStatusValue,
  validFrom: Date,
  validUntil: Date,
  totalUses: number | null,
  redeemedCount: number,
  now: Date = new Date(),
): boolean {
  return effectiveStatus(stored, validFrom, validUntil, totalUses, redeemedCount, now) === 'active';
}
