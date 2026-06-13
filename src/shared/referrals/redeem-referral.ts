/**
 * Referral redemption — instant-redeem model. The current consumer (referee) enters a
 * friend's (referrer's) code. Both are credited loyalty points (kind='bonus'): referrer
 * gets `referrer_points`, referee gets `referred_points` (platform config). A consumer
 * may redeem at most once (the referrals.referee unique index enforces it). Self-referral
 * is rejected. Rewards-banned sides are recorded with 0 points granted.
 */
import { eq, inArray } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { consumers, platformConfig, referrals } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { applyLoyaltyDelta } from '@/shared/loyalty/apply-delta.js';
import { isRewardsBanned } from '@/shared/loyalty/grant.js';

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

export type RedeemReferralResult = {
  referrerName: string;
  referrerPointsGranted: number;
  refereePointsGranted: number;
};

/**
 * Credit a loyalty 'bonus' (skipped → 0 if rewards-banned). The ban check reads inside the
 * caller's transaction snapshot; the credit goes through the CAS-guarded balance row. Returns
 * points granted.
 */
async function grantBonus(
  tx: Tx,
  consumerId: string,
  points: number,
  note: string,
): Promise<number> {
  if (points <= 0) return 0;
  if (await isRewardsBanned(consumerId, tx)) return 0;
  await applyLoyaltyDelta(tx, { consumerId, points, kind: 'bonus', note });
  return points;
}

export async function redeemReferral(
  database: typeof Db,
  input: { refereeConsumerId: string; code: string },
): Promise<RedeemReferralResult> {
  const referrer = await database.query.consumers.findFirst({
    where: eq(consumers.referralCode, input.code.trim().toUpperCase()),
    columns: { id: true, name: true },
  });
  if (!referrer) {
    throw new AppError(404, ErrorCode.ReferralCodeInvalid, 'Referral code not found');
  }
  if (referrer.id === input.refereeConsumerId) {
    throw new AppError(400, ErrorCode.ReferralSelf, 'You cannot redeem your own referral code');
  }

  // Config points (defaults match the seed).
  const cfgRows = await database.query.platformConfig.findMany({
    where: inArray(platformConfig.key, ['referrer_points', 'referred_points']),
  });
  const cfg = new Map(cfgRows.map((r) => [r.key, r.value as number]));
  const referrerPoints = (cfg.get('referrer_points') as number) ?? 200;
  const refereePoints = (cfg.get('referred_points') as number) ?? 100;

  return database.transaction(async (tx) => {
    // Claim first — the referee unique index rejects a second redemption.
    try {
      await tx.insert(referrals).values({
        id: newId(IdPrefix.Referral),
        referrerConsumerId: referrer.id,
        refereeConsumerId: input.refereeConsumerId,
        referrerPoints,
        refereePoints,
      });
    } catch (err) {
      const e = err as { code?: string; cause?: { code?: string } };
      if (e?.code === '23505' || e?.cause?.code === '23505') {
        throw new AppError(409, ErrorCode.ReferralAlreadyUsed, 'You have already used a referral code');
      }
      throw err;
    }

    const referrerGranted = await grantBonus(
      tx,
      referrer.id,
      referrerPoints,
      `Referral bonus — referred ${input.refereeConsumerId}`,
    );
    const refereeGranted = await grantBonus(
      tx,
      input.refereeConsumerId,
      refereePoints,
      `Referral welcome bonus — code ${input.code.trim().toUpperCase()}`,
    );

    return {
      // OTP-only consumers may not have set a name yet.
      referrerName: referrer.name ?? 'Your friend',
      referrerPointsGranted: referrerGranted,
      refereePointsGranted: refereeGranted,
    };
  });
}
