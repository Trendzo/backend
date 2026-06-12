/**
 * Consumer referrals. `GET /me` returns the consumer's own code + share link + stats;
 * `POST /redeem` redeems a friend's code (instant loyalty-point bonus for both sides).
 */
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { consumers, referrals } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import { redeemReferral } from '@/shared/referrals/redeem-referral.js';
import type { RedeemBody } from './referrals.validators.js';

type Auth = AccessTokenPayload;

export async function getMine(input: { auth: Auth }) {
  const me = await db.query.consumers.findFirst({
    where: eq(consumers.id, input.auth.sub),
    columns: { referralCode: true },
  });
  if (!me) throw new AppError(404, ErrorCode.NotFound, 'Consumer not found');

  // People I referred.
  const referredRows = await db.query.referrals.findMany({
    where: eq(referrals.referrerConsumerId, input.auth.sub),
    columns: { referrerPoints: true },
  });
  const referredCount = referredRows.length;
  const pointsEarned = referredRows.reduce((s, r) => s + r.referrerPoints, 0);

  // Whether I've redeemed someone's code.
  const myRedemption = await db.query.referrals.findFirst({
    where: eq(referrals.refereeConsumerId, input.auth.sub),
    columns: { refereePoints: true },
  });

  const code = me.referralCode;
  return ok({
    code,
    shareLink: code ? `https://closetx.app/invite/${code}` : null,
    referredCount,
    pointsEarned,
    redeemed: Boolean(myRedemption),
    refereePointsEarned: myRedemption?.refereePoints ?? 0,
  });
}

export async function redeem(input: { auth: Auth; body: z.infer<typeof RedeemBody> }) {
  const result = await redeemReferral(db, {
    refereeConsumerId: input.auth.sub,
    code: input.body.code,
  });
  return ok(result);
}
