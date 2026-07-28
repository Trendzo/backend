/**
 * Turns a won slice into something the consumer actually holds.
 *
 * Two prize shapes, two existing mechanisms — no new rewards system:
 *
 *   promotion → a single-use `voucher_codes` row with `assigned_consumer_id` set. That one
 *               row is already understood end to end: `compute-quote.ts` rejects it for
 *               anyone else (and for guests), `place-order.ts` burns it with a CAS, and
 *               `promotion_redemptions` logs the spend. All the eligibility the admin
 *               attached — min order value, first-order-only, per-consumer limit, tier,
 *               store scope, expiry — is the promotion's, enforced where it always was.
 *
 *   points    → `applyLoyaltyDelta(kind:'bonus')`, the same call the referral bonus uses
 *               for a non-purchase award.
 *
 * Until now the only code that could create an assigned voucher was two admin HTTP
 * handlers, inline. This is that logic factored into something callable.
 */
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { promotionConsumerGrants, spinWheelSegments, voucherCodes } from '@/db/schema/index.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { applyLoyaltyDelta } from '@/shared/loyalty/apply-delta.js';
import { generateCodes } from '@/shared/promotions/voucher-codes.js';

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

/** Postgres unique-violation. The voucher-code generator's contract says to re-roll on it. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === UNIQUE_VIOLATION;
}

/**
 * Mint a single-use voucher for `promotionId` bound to `consumerId`.
 *
 * The code alphabet has ~1.1e12 members so collisions are theoretical, but the DB owns
 * uniqueness and the generator's header is explicit that callers must catch 23505 and
 * re-roll. Five attempts is far past the point of suspecting anything but a real bug.
 */
export async function issueAssignedVoucher(
  tx: Tx,
  args: { promotionId: string; consumerId: string; prefix?: string; source: string },
): Promise<{ voucherCodeId: string; code: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCodes(1, args.prefix ?? '')[0]!;
    const voucherCodeId = newId(IdPrefix.VoucherCode);
    try {
      await tx.insert(voucherCodes).values({
        id: voucherCodeId,
        promotionId: args.promotionId,
        code,
        totalUses: 1,
        assignedConsumerId: args.consumerId,
      });

      /**
       * Mirror the grant so the consumer's rewards list can join uniformly across coupon
       * and voucher grants, exactly as the targeted-drop path does. `source` distinguishes
       * this from an admin push. The unique (promotion, consumer) index means a second win
       * on the same promotion cannot add a second grant row — that is fine and deliberate:
       * the voucher above is the prize, the grant is only the wallet entry.
       */
      await tx
        .insert(promotionConsumerGrants)
        .values({
          id: newId(IdPrefix.PromotionGrant),
          promotionId: args.promotionId,
          consumerId: args.consumerId,
          source: args.source,
          voucherCodeId,
        })
        .onConflictDoNothing({
          target: [promotionConsumerGrants.promotionId, promotionConsumerGrants.consumerId],
        });

      return { voucherCodeId, code };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // Collided on voucher_codes.code — re-roll and try again.
    }
  }
  throw new Error('could not mint a unique voucher code after 5 attempts');
}

/** Award points for a non-purchase event, through the one loyalty choke-point. */
export async function issuePoints(
  tx: Tx,
  args: { consumerId: string; points: number; note: string },
): Promise<void> {
  await applyLoyaltyDelta(tx, {
    consumerId: args.consumerId,
    points: args.points,
    kind: 'bonus',
    note: args.note,
  });
}

/**
 * Claim one unit of a slice's global stock.
 *
 * Compare-and-swap in the same shape as `bumpPromotionCounter` — `UPDATE … WHERE capacity
 * remains RETURNING`. Returns false when the slice sold out between the draw and here,
 * which the caller treats as "re-draw", not as an error. Without this, two people spinning
 * at the same millisecond could both win the last jackpot.
 */
export async function claimSegmentStock(tx: Tx, segmentId: string): Promise<boolean> {
  const [row] = await tx
    .update(spinWheelSegments)
    .set({ stockIssued: sql`${spinWheelSegments.stockIssued} + 1` })
    .where(
      and(
        eq(spinWheelSegments.id, segmentId),
        or(
          isNull(spinWheelSegments.stockTotal),
          lt(spinWheelSegments.stockIssued, spinWheelSegments.stockTotal),
        ),
      ),
    )
    .returning({ id: spinWheelSegments.id });
  return Boolean(row);
}
