/**
 * Delegation-mode defaults per capability (PRODUCT_SPEC §"Delegation Modes", line 1207).
 *
 * MVP only ships `locked` / `open` — the request-gated modes (`request_manual`,
 * `request_auto_accept`, `request_auto_decline`) ship in v1.1, alongside the
 * `capability_request` table that is currently skipped from initial development.
 *
 * Defaults below are encoded as a constant the application reads — there is no dedicated
 * `delegation_mode` table in the MVP schema. When request-gated modes ship, this seed will
 * write to a new table.
 */

import type { db as Db } from '@/db/client.js';

type DelegationMode = 'locked' | 'open';

/**
 * Per spec line 1207: `promotions_issuance` is delegated separately for offers, coupons,
 * and vouchers — each mechanism gets its own mode. The other capabilities are flat.
 */
type Capability =
  | 'listing_policy_choice'
  | 'delivery_fee_override'
  | 'handling_fee'
  | 'convenience_fee'
  | 'promotions_issuance__offers'
  | 'promotions_issuance__coupons'
  | 'promotions_issuance__vouchers';

export const DELEGATION_MODE_DEFAULTS: Readonly<Record<Capability, DelegationMode>> = {
  listing_policy_choice: 'open', // retailers know their products best
  delivery_fee_override: 'locked', // consistency at launch
  handling_fee: 'locked', // same reasoning
  convenience_fee: 'locked', // same reasoning
  promotions_issuance__offers: 'open', // retailers can run promos on their own catalog
  promotions_issuance__coupons: 'locked', // coupon abuse risk; admin enables per retailer once trusted
  promotions_issuance__vouchers: 'locked', // same as coupons
};

export function seedDelegationModes(_db: typeof Db): Promise<void> {
  // No-op for MVP — delegation modes are read from this constant, not the DB.
  // Wired into the orchestrator so the seed step is visible end-to-end.
  return Promise.resolve();
}
