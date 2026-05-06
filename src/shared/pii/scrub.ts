/**
 * PII scrub for consumer-account deletion.
 *
 * Per spec §"PII snapshots on orders": when a consumer is deleted, their PII snapshots on
 * the `order` row are scrubbed (replaced with anonymous reference id), but the rest of the
 * order — store snapshot, prices, listing snapshots — stays intact so the order remains
 * self-contained for store-side display, payouts, and admin audit.
 *
 * `invoice` and `credit_note` PII is INTENTIONALLY NOT touched — Indian GST rules require
 * tax invoices be reproducible as-issued for ~8 years (legal hold).
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { orders } from '@/db/schema/index.js';

const ANON_NAME = '[deleted consumer]';
const ANON_EMAIL = 'deleted@anonymised.local';
const ANON_PHONE = '0000000000';
const ANON_ADDRESS_LINE = '[deleted address]';

/**
 * Scrub PII fields on every order belonging to a consumer. Idempotent — re-running on an
 * already-scrubbed consumer is a no-op (filtered by `pii_scrubbed_at IS NULL`).
 *
 * Address fields are guarded: pickup orders have NULL address snaps, and overwriting NULL
 * with a placeholder would destroy the pickup-vs-delivery signal future audits depend on.
 *
 * Returns the number of orders scrubbed.
 */
export async function scrubConsumerOrderPii(
  db: typeof Db,
  consumerId: string,
  anonymousReferenceId: string,
): Promise<number> {
  const result = await db
    .update(orders)
    .set({
      consumerNameSnap: `${ANON_NAME} (${anonymousReferenceId})`,
      consumerEmailSnap: ANON_EMAIL,
      consumerPhoneSnap: ANON_PHONE,
      // Preserve NULL on pickup orders — only blank set fields.
      addressLine1Snap: sql`CASE WHEN ${orders.addressLine1Snap} IS NULL THEN NULL ELSE ${ANON_ADDRESS_LINE} END`,
      addressLine2Snap: sql`CASE WHEN ${orders.addressLine2Snap} IS NULL THEN NULL ELSE NULL END`,
      // city / pincode / state_code / lat / lng are NOT PII — leave for routing analytics
      piiScrubbedAt: new Date(),
    })
    .where(and(eq(orders.consumerId, consumerId), isNull(orders.piiScrubbedAt)))
    .returning({ id: orders.id });

  return result.length;
}
