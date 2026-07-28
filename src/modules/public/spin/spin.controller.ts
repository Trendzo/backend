/**
 * Spin & Win — the consumer-facing half.
 *
 * Two rules shape everything here:
 *
 *  1. **The server decides the outcome.** The app is told a slice index and animates to it.
 *     Weights are never serialised to a client.
 *
 *  2. **A prize is a promotion voucher.** Winning does not create a bespoke reward object;
 *     it mints a single-use `voucher_codes` row against a promotion the admin configured.
 *     Redemption then flows down the path that already exists — the checkout coupon field,
 *     `compute-quote`'s eligibility gates, `place-order`'s single-use CAS.
 *
 * A guest may spin. Their win parks as `pending_claim` with an opaque token; signing in and
 * presenting that token binds it to their account. `compute-quote.ts:197` already refuses an
 * assigned voucher for an unauthenticated caller, so an unclaimed prize is unspendable by
 * construction rather than by a check someone has to remember to write.
 */
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@/db/client.js';
import {
  promotions,
  spinPlays,
  spinWheelSegments,
  spinWheels,
  voucherCodes,
} from '@/db/schema/index.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { isRewardsBanned } from '@/shared/loyalty/grant.js';
import { claimSegmentStock, issueAssignedVoucher, issuePoints } from '@/shared/spin/issue-prize.js';
import { isExhausted, pickSegment } from '@/shared/spin/pick-segment.js';
import type { SpinSurface } from './spin.validators.js';
import type { z } from 'zod';

type Surface = z.infer<typeof SpinSurface>;
type Auth = AccessTokenPayload | undefined;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** UTC instant of the most recent IST midnight — the boundary the daily cap resets on. */
function istTodayStart(): Date {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

/** The live wheel for a surface, or null. `status='active'` is the admin's on/off switch. */
async function activeWheel(surface: Surface) {
  const now = new Date();
  const wheel = await db.query.spinWheels.findFirst({
    where: and(
      eq(spinWheels.status, 'active'),
      lte(spinWheels.validFrom, now),
      gte(spinWheels.validUntil, now),
    ),
  });
  if (!wheel) return null;
  // `surface` is 'popup' | 'screen' | 'both' on the row; the caller asks for one of the two.
  if (wheel.surface !== 'both' && wheel.surface !== surface) return null;
  return wheel;
}

async function spinsUsedToday(deviceId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(spinPlays)
    .where(and(eq(spinPlays.deviceId, deviceId), gte(spinPlays.playedAt, istTodayStart())));
  return row?.n ?? 0;
}

/** How many prizes this account has already taken from this wheel, ever. */
async function claimsByConsumer(wheelId: string, consumerId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(spinPlays)
    .where(
      and(
        eq(spinPlays.wheelId, wheelId),
        eq(spinPlays.consumerId, consumerId),
        eq(spinPlays.status, 'claimed'),
      ),
    );
  return row?.n ?? 0;
}

/**
 * GET /spin/wheel — what to draw, and whether this device may still spin.
 *
 * Returns `{ wheel: null }` rather than a 404 when nothing is running: "there is no wheel"
 * is a normal state the app must render (by showing nothing), not an error worth a red
 * banner. Note the absence of `weightBp` in the projection — that is the point.
 */
export async function getWheel(input: { auth: Auth; query: { deviceId: string; surface: Surface } }) {
  const wheel = await activeWheel(input.query.surface);
  if (!wheel) return ok({ wheel: null });
  if (!wheel.guestSpinAllowed && !input.auth) return ok({ wheel: null });

  const segments = await db.query.spinWheelSegments.findMany({
    where: eq(spinWheelSegments.wheelId, wheel.id),
    orderBy: (t, { asc }) => [asc(t.sortOrder)],
  });

  const used = await spinsUsedToday(input.query.deviceId);
  let spinsLeftToday = Math.max(0, wheel.spinsPerDevicePerDay - used);

  // An account that has already taken everything this wheel will ever give it should not be
  // invited to spin again — the spin would only end in a rejected claim.
  if (input.auth && wheel.maxClaimsPerConsumer !== null) {
    const claimed = await claimsByConsumer(wheel.id, input.auth.sub);
    if (claimed >= wheel.maxClaimsPerConsumer) spinsLeftToday = 0;
  }

  return ok({
    wheel: {
      id: wheel.id,
      name: wheel.name,
      spinsLeftToday,
      guestSpinAllowed: wheel.guestSpinAllowed,
      segments: segments.map((s) => ({
        id: s.id,
        sortOrder: s.sortOrder,
        label: s.label,
        sublabel: s.sublabel,
        icon: s.icon,
        colorHex: s.colorHex,
        // Whether a slice can still pay out is visible (a spent jackpot should look spent);
        // how likely it is to be picked is not.
        soldOut: isExhausted(s),
      })),
    },
  });
}

/** Shape a claimed prize for the client. */
function prizePayload(args: { code?: string | null; points?: number | null; label: string }) {
  return {
    code: args.code ?? null,
    points: args.points ?? null,
    label: args.label,
  };
}

/**
 * POST /spin/play — draw a slice and record it.
 *
 * The whole thing runs in one transaction behind an advisory lock on the device id. Without
 * that lock two taps landing in the same millisecond both read "0 spins used" and both get a
 * prize; the same `pg_advisory_xact_lock(hashtext(...))` idiom guards the inventory importer.
 */
export async function play(input: { auth: Auth; body: { deviceId: string; surface: Surface } }) {
  const wheel = await activeWheel(input.body.surface);
  if (!wheel) throw new AppError(404, ErrorCode.NotFound, 'No wheel is running right now');
  if (!wheel.guestSpinAllowed && !input.auth) {
    throw AppError.unauthorized('Sign in to spin');
  }
  if (input.auth && (await isRewardsBanned(input.auth.sub))) {
    throw AppError.forbidden('Rewards are disabled on this account');
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'spin:' + input.body.deviceId}))`);

    const [usedRow] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(spinPlays)
      .where(
        and(eq(spinPlays.deviceId, input.body.deviceId), gte(spinPlays.playedAt, istTodayStart())),
      );
    if ((usedRow?.n ?? 0) >= wheel.spinsPerDevicePerDay) {
      throw new AppError(409, ErrorCode.AlreadySpun, 'No spins left today — come back tomorrow');
    }

    if (input.auth && wheel.maxClaimsPerConsumer !== null) {
      const [claimedRow] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(spinPlays)
        .where(
          and(
            eq(spinPlays.wheelId, wheel.id),
            eq(spinPlays.consumerId, input.auth.sub),
            eq(spinPlays.status, 'claimed'),
          ),
        );
      if ((claimedRow?.n ?? 0) >= wheel.maxClaimsPerConsumer) {
        throw new AppError(409, ErrorCode.AlreadyClaimed, 'You have already claimed your prize');
      }
    }

    const segments = await tx
      .select()
      .from(spinWheelSegments)
      .where(eq(spinWheelSegments.wheelId, wheel.id))
      .orderBy(spinWheelSegments.sortOrder);
    if (segments.length === 0) {
      throw new AppError(409, ErrorCode.InvalidState, 'This wheel has no slices configured');
    }

    /**
     * Draw, then claim stock. `claimSegmentStock` is a CAS, so if another spinner took the
     * last unit between our read and our write it returns false and we draw again from a
     * pool that now excludes this slice. Bounded by the slice count — each failed attempt
     * permanently removes one candidate, so this cannot spin forever.
     */
    let pool = segments;
    let chosen: (typeof segments)[number] | null = null;
    for (let attempt = 0; attempt < segments.length; attempt++) {
      const candidate = pickSegment(pool);
      if (!candidate) break;
      if (candidate.stockTotal === null || (await claimSegmentStock(tx, candidate.id))) {
        chosen = candidate;
        break;
      }
      pool = pool.filter((s) => s.id !== candidate.id);
    }
    if (!chosen) {
      throw new AppError(409, ErrorCode.CouponExhausted, 'All prizes have been claimed');
    }

    const claimToken = `spt_${randomUUID().replace(/-/g, '')}`;
    const claimExpiresAt = new Date(Date.now() + wheel.claimWindowHours * 3600 * 1000);
    const playId = newId(IdPrefix.SpinPlay);

    // A losing slice is terminal on the spot: nothing to claim, so nothing to expire.
    const isWin = chosen.rewardKind !== 'none';
    let code: string | null = null;
    let points: number | null = null;
    let voucherCodeId: string | null = null;
    let status: 'pending_claim' | 'claimed' | 'no_prize' = isWin ? 'pending_claim' : 'no_prize';

    // Signed in already? Then there is nothing to defer — hand the prize over now.
    if (isWin && input.auth) {
      if (chosen.rewardKind === 'promotion') {
        const issued = await issueAssignedVoucher(tx, {
          promotionId: chosen.promotionId!,
          consumerId: input.auth.sub,
          source: 'spin_wheel',
        });
        code = issued.code;
        voucherCodeId = issued.voucherCodeId;
      } else {
        points = chosen.points!;
        await issuePoints(tx, {
          consumerId: input.auth.sub,
          points,
          note: `Spin & Win — ${chosen.label}`,
        });
      }
      status = 'claimed';
    }

    await tx.insert(spinPlays).values({
      id: playId,
      wheelId: wheel.id,
      segmentId: chosen.id,
      deviceId: input.body.deviceId,
      consumerId: input.auth?.sub ?? null,
      status,
      claimToken,
      claimExpiresAt: isWin ? claimExpiresAt : null,
      voucherCodeId,
      pointsAwarded: points,
      claimedAt: status === 'claimed' ? new Date() : null,
    });

    return ok({
      playId,
      // Position on the rendered wheel — the app animates the pointer to this slice.
      segmentIndex: chosen.sortOrder,
      segmentId: chosen.id,
      label: chosen.label,
      sublabel: chosen.sublabel,
      won: isWin,
      rewardKind: chosen.rewardKind,
      requiresLogin: isWin && !input.auth,
      claimToken: isWin ? claimToken : null,
      claimExpiresAt: isWin ? claimExpiresAt : null,
      prize: status === 'claimed' ? prizePayload({ code, points, label: chosen.label }) : null,
    });
  });
}

/**
 * POST /spin/claim — bind a guest's pending win to the account that just signed in.
 *
 * Idempotent on `claimToken`: replaying it returns the same voucher rather than minting a
 * second one. That matters because the app claims immediately after an OTP round-trip, which
 * is exactly when a flaky connection makes a client retry.
 */
export async function claim(input: { auth: AccessTokenPayload; body: { claimToken: string } }) {
  if (await isRewardsBanned(input.auth.sub)) {
    throw AppError.forbidden('Rewards are disabled on this account');
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(spinPlays)
      .where(eq(spinPlays.claimToken, input.body.claimToken))
      .for('update');
    if (!row) throw new AppError(404, ErrorCode.NotFound, 'That prize could not be found');

    if (row.status === 'no_prize') {
      return ok({ won: false, prize: null });
    }

    // Already settled — replay the answer instead of issuing again.
    if (row.status === 'claimed') {
      if (row.consumerId !== input.auth.sub) {
        throw AppError.forbidden('That prize belongs to another account');
      }
      const existing = row.voucherCodeId
        ? await tx.query.voucherCodes.findFirst({ where: eq(voucherCodes.id, row.voucherCodeId) })
        : null;
      const seg = await tx.query.spinWheelSegments.findFirst({
        where: eq(spinWheelSegments.id, row.segmentId),
      });
      return ok({
        won: true,
        alreadyClaimed: true,
        prize: prizePayload({
          code: existing?.code ?? null,
          points: row.pointsAwarded,
          label: seg?.label ?? '',
        }),
      });
    }

    if (row.status === 'expired' || (row.claimExpiresAt && row.claimExpiresAt < new Date())) {
      await tx.update(spinPlays).set({ status: 'expired' }).where(eq(spinPlays.id, row.id));
      throw new AppError(409, ErrorCode.CouponExpired, 'This prize has expired');
    }

    // A signed-in spin already has a consumer; a guest spin has none. Either way it must not
    // be someone else's.
    if (row.consumerId && row.consumerId !== input.auth.sub) {
      throw AppError.forbidden('That prize belongs to another account');
    }

    const wheel = await tx.query.spinWheels.findFirst({ where: eq(spinWheels.id, row.wheelId) });
    if (wheel?.maxClaimsPerConsumer != null) {
      const [claimedRow] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(spinPlays)
        .where(
          and(
            eq(spinPlays.wheelId, row.wheelId),
            eq(spinPlays.consumerId, input.auth.sub),
            eq(spinPlays.status, 'claimed'),
          ),
        );
      if ((claimedRow?.n ?? 0) >= wheel.maxClaimsPerConsumer) {
        throw new AppError(409, ErrorCode.AlreadyClaimed, 'You have already claimed your prize');
      }
    }

    const seg = await tx.query.spinWheelSegments.findFirst({
      where: eq(spinWheelSegments.id, row.segmentId),
    });
    if (!seg) throw new AppError(500, ErrorCode.InternalError, 'Prize slice vanished');

    let code: string | null = null;
    let points: number | null = null;
    let voucherCodeId: string | null = null;

    if (seg.rewardKind === 'promotion') {
      const issued = await issueAssignedVoucher(tx, {
        promotionId: seg.promotionId!,
        consumerId: input.auth.sub,
        source: 'spin_wheel',
      });
      code = issued.code;
      voucherCodeId = issued.voucherCodeId;
    } else if (seg.rewardKind === 'points') {
      points = seg.points!;
      await issuePoints(tx, {
        consumerId: input.auth.sub,
        points,
        note: `Spin & Win — ${seg.label}`,
      });
    }

    await tx
      .update(spinPlays)
      .set({
        consumerId: input.auth.sub,
        status: 'claimed',
        claimedAt: new Date(),
        voucherCodeId,
        pointsAwarded: points,
      })
      .where(eq(spinPlays.id, row.id));

    return ok({
      won: true,
      alreadyClaimed: false,
      prize: prizePayload({ code, points, label: seg.label }),
    });
  });
}

/**
 * GET /consumer/rewards — the vouchers this account personally holds.
 *
 * `/promotions/active` deliberately excludes vouchers, and nothing else lists a consumer's
 * own grants, so before this a won prize was invisible between the toast that announced it
 * and the checkout field where it might work. Unredeemed first, then most recent.
 */
export async function listRewards(input: { auth: AccessTokenPayload }) {
  const rows = await db
    .select({
      voucherId: voucherCodes.id,
      code: voucherCodes.code,
      totalUses: voucherCodes.totalUses,
      redeemedCount: voucherCodes.redeemedCount,
      createdAt: voucherCodes.createdAt,
      promotionId: promotions.id,
      name: promotions.name,
      discountType: promotions.discountType,
      config: promotions.config,
      status: promotions.status,
      validFrom: promotions.validFrom,
      validUntil: promotions.validUntil,
    })
    .from(voucherCodes)
    .innerJoin(promotions, eq(voucherCodes.promotionId, promotions.id))
    .where(eq(voucherCodes.assignedConsumerId, input.auth.sub))
    .orderBy(desc(voucherCodes.createdAt))
    .limit(100);

  const now = new Date();
  return ok({
    rewards: rows.map((r) => {
      const spent = r.totalUses !== null && r.redeemedCount >= r.totalUses;
      const expired = r.validUntil < now || r.status === 'expired' || r.status === 'revoked';
      return {
        id: r.voucherId,
        code: r.code,
        name: r.name,
        discountType: r.discountType,
        config: r.config,
        validUntil: r.validUntil,
        // One flat state for the app to switch on, rather than four booleans it has to
        // combine correctly in three different screens.
        state: spent ? 'used' : expired ? 'expired' : 'available',
        wonAt: r.createdAt,
      };
    }),
  });
}
