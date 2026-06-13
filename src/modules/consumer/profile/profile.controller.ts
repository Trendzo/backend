/**
 * Consumer self-profile. OTP signups start with only a verified phone; this module lets
 * the app read the session profile and fill in name/email/genderPreference (required
 * before checkout — order snapshots freeze name + email as NOT NULL columns).
 */
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { consumers } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type { UpdateMeBody } from './profile.validators.js';

type Auth = AccessTokenPayload;

function shapeMe(c: typeof consumers.$inferSelect) {
  return {
    id: c.id,
    phone: c.phone,
    name: c.name,
    email: c.email,
    genderPreference: c.genderPreference,
    referralCode: c.referralCode,
    profileComplete: !!(c.name && c.email),
  };
}

export async function getMe(input: { auth: Auth }) {
  const me = await db.query.consumers.findFirst({ where: eq(consumers.id, input.auth.sub) });
  if (!me) throw new AppError(404, ErrorCode.NotFound, 'Account not found');
  return ok(shapeMe(me));
}

export async function updateMe(input: { auth: Auth; body: z.infer<typeof UpdateMeBody> }) {
  const { auth, body } = input;
  try {
    const updated = await db
      .update(consumers)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.email !== undefined && { email: body.email }),
        ...(body.genderPreference !== undefined && { genderPreference: body.genderPreference }),
      })
      .where(eq(consumers.id, auth.sub))
      .returning();
    const me = updated[0];
    if (!me) throw new AppError(404, ErrorCode.NotFound, 'Account not found');
    return ok(shapeMe(me));
  } catch (err) {
    // consumers_email_idx unique violation — the email belongs to another account.
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      throw new AppError(
        409,
        ErrorCode.EmailAlreadyTaken,
        'An account with this email already exists',
      );
    }
    throw err;
  }
}
