/**
 * Atomic redemption counter helpers. Built but NOT wired into a public route — Phase 7
 * checkout will call these inside its order-placement transaction.
 *
 * The pattern uses Postgres's `UPDATE … WHERE … RETURNING` for compare-and-swap:
 *   - Promotion-level: `UPDATE promotions SET redeemed_count = redeemed_count + 1
 *                       WHERE id = ? AND (total_uses IS NULL OR redeemed_count < total_uses)`
 *     Returns the row on success, no row on cap-hit (caller raises CouponExhausted).
 *
 *   - Voucher-code-level: same pattern against voucher_codes.
 *
 * Both are wrapped here so checkout doesn't have to re-derive the SQL.
 */
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { promotions, voucherCodes } from '@/db/schema/index.js';

/**
 * Atomically bump a promotion's redeemed_count if there's still capacity. Returns the
 * new count on success, null when capacity is exhausted.
 */
export async function bumpPromotionCounter(
  database: typeof Db,
  promotionId: string,
): Promise<number | null> {
  const [row] = await database
    .update(promotions)
    .set({ redeemedCount: sql`${promotions.redeemedCount} + 1` })
    .where(
      and(
        eq(promotions.id, promotionId),
        or(isNull(promotions.totalUses), lt(promotions.redeemedCount, promotions.totalUses)),
      ),
    )
    .returning({ redeemedCount: promotions.redeemedCount });
  return row ? row.redeemedCount : null;
}

/** Same pattern for voucher codes. */
export async function bumpVoucherCodeCounter(
  database: typeof Db,
  voucherCodeId: string,
): Promise<number | null> {
  const [row] = await database
    .update(voucherCodes)
    .set({ redeemedCount: sql`${voucherCodes.redeemedCount} + 1` })
    .where(
      and(
        eq(voucherCodes.id, voucherCodeId),
        or(
          isNull(voucherCodes.totalUses),
          lt(voucherCodes.redeemedCount, voucherCodes.totalUses),
        ),
      ),
    )
    .returning({ redeemedCount: voucherCodes.redeemedCount });
  return row ? row.redeemedCount : null;
}
