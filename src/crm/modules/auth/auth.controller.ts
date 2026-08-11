import { randomInt } from 'node:crypto';
import type { z } from 'zod';
import { env } from '@/config/env.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { signAccessToken } from '@/shared/auth/jwt.js';
import { verifyMsg91AccessToken } from '@/shared/msg91/verify.js';
import { crm } from '../../db/client.js';
import type { CrmUser } from '../../db/types.js';
import { CrmIdPrefix, crmId, nowIso } from '../../store.js';
import type { CrmRequestOtpBody, CrmMsg91Body, CrmVerifyOtpBody } from './auth.validators.js';

/**
 * Sales sign-in for the field CRM.
 *
 * Production path is MSG91 phone-OTP, identical in shape to the retailer/driver flows already
 * in this backend: the browser drives send/verify against the MSG91 widget, receives a
 * short-lived access token, and posts it here. The token is NOT trusted as-is — it is
 * re-verified server-side against MSG91 with the secret account authkey, and only the phone
 * number MSG91 attests is used. The CRM reuses the retailer MSG91 account (same `tokenAuth`,
 * same authkey), so no new credentials are needed.
 *
 * Unlike consumer/driver login, this NEVER creates an account: a salesperson must be added by
 * an admin first. An unknown phone is a hard 404 with an actionable message.
 *
 * A local-OTP path exists alongside it for development and the automated Playwright suite;
 * it is inert unless `CRM_DEV_OTP=true`, and it refuses to arm in production regardless.
 */

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

/** True when the local OTP path may be used at all. Never true in production. */
export function devOtpEnabled(): boolean {
  return env.CRM_DEV_OTP === 'true' && env.NODE_ENV !== 'production';
}

function assertDevOtpEnabled(): void {
  if (!devOtpEnabled()) {
    throw new AppError(
      404,
      ErrorCode.NotFound,
      'Local OTP sign-in is disabled. Use the OTP sent to your phone.',
    );
  }
}

function shapeUser(user: CrmUser) {
  return {
    id: user._id,
    name: user.name,
    mobile: user.phone,
    role: user.role,
    employee_id: user.employeeId,
    territory_id: user.territoryId,
    manager_id: user.managerId,
  };
}

async function findActiveSalesUser(phone: string): Promise<CrmUser> {
  const users = await crm.users();
  const user = await users.findOne({ phone });
  if (!user) {
    throw new AppError(
      404,
      ErrorCode.NotFound,
      'No sales account found for this number. Ask your admin to add you.',
    );
  }
  if (!user.active) {
    throw new AppError(403, ErrorCode.Forbidden, 'Your access has been deactivated');
  }
  if (user.role === 'admin') {
    throw new AppError(403, ErrorCode.Forbidden, 'Use the admin sign-in for this account');
  }
  return user;
}

async function issueSession(user: CrmUser) {
  const users = await crm.users();
  const at = nowIso();
  await users.updateOne({ _id: user._id }, { $set: { lastLoginAt: at } });
  const token = signAccessToken(
    { sub: user._id, kind: 'crm', subRole: user.role, ver: user.tokenVersion ?? 0 },
    { expiresIn: env.JWT_CRM_ACCESS_EXPIRES_IN },
  );
  return ok({ token, user: shapeUser({ ...user, lastLoginAt: at }) });
}

/** Production sign-in: re-verify the MSG91 widget token, then match the attested phone. */
export async function salesMsg91Login(input: { body: z.infer<typeof CrmMsg91Body> }) {
  // The CRM's web widget lives under the same MSG91 account as the retailer portal widget,
  // so the retailer account authkey verifies its tokens (verification is account-scoped,
  // not widget-scoped).
  const authKey = env.MSG91_RETAILER_AUTH_KEY;
  if (!authKey) {
    throw new AppError(
      503,
      ErrorCode.InternalError,
      'OTP verification is not configured (missing MSG91 credentials).',
    );
  }
  const phone = await verifyMsg91AccessToken(input.body.accessToken, {
    format: 'national',
    authKey,
  });
  const user = await findActiveSalesUser(phone);
  return issueSession(user);
}

/**
 * Start sign-in: confirm the number belongs to an active salesperson.
 *
 * Always available, in both modes, because the client needs this check BEFORE asking MSG91 to
 * send anything — otherwise every typo burns an SMS credit and the user only learns the number
 * is unknown after waiting for a code that will never arrive. It also supplies the name for the
 * "Welcome, <first name>" greeting.
 *
 * In MSG91 mode that is all it does; the browser then drives the widget. Only when the local
 * OTP path is armed does it additionally mint a code and hand it back, so an automated run can
 * complete the flow without SMS. That code is stored and verified exactly like a real one —
 * expiry and attempt limits included — so tests exercise the same verification path.
 */
export async function startSignIn(input: { body: z.infer<typeof CrmRequestOtpBody> }) {
  const { phone } = input.body;
  const user = await findActiveSalesUser(phone);

  if (!devOtpEnabled()) {
    return ok({ sent: false, name: user.name, devOtp: null });
  }

  const code = String(randomInt(100000, 1000000));
  const otps = await crm.otps();
  await otps.deleteMany({ phone });
  await otps.insertOne({
    _id: crmId(CrmIdPrefix.Otp),
    phone,
    code,
    attempts: 0,
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
    createdAt: nowIso(),
  });

  return ok({ sent: true, name: user.name, devOtp: code });
}

/** Local OTP verify (dev/test only). Attempt-limited so a 6-digit code can't be ground down. */
export async function verifyDevOtp(input: { body: z.infer<typeof CrmVerifyOtpBody> }) {
  assertDevOtpEnabled();
  const { phone, code } = input.body;
  const otps = await crm.otps();
  const row = await otps.findOne({ phone }, { sort: { createdAt: -1 } });

  if (!row || row.expiresAt.getTime() < Date.now()) {
    throw new AppError(401, ErrorCode.InvalidCredentials, 'That code has expired. Request a new one.');
  }
  if (row.attempts >= MAX_OTP_ATTEMPTS) {
    await otps.deleteMany({ phone });
    throw new AppError(429, ErrorCode.RateLimited, 'Too many attempts. Request a new code.');
  }
  if (row.code !== code) {
    await otps.updateOne({ _id: row._id }, { $inc: { attempts: 1 } });
    throw new AppError(401, ErrorCode.InvalidCredentials, 'Incorrect code. Try again.');
  }

  await otps.deleteMany({ phone });
  const user = await findActiveSalesUser(phone);
  return issueSession(user);
}

/**
 * Whoever is signed in, shaped for the client. Sales users get their territory + manager
 * resolved; platform admins get a minimal identity (they have no CRM user row by design).
 */
export async function me(input: { actorKind: 'sales' | 'admin'; id: string; name: string }) {
  if (input.actorKind === 'admin') {
    return ok({
      user: {
        id: input.id,
        name: input.name,
        role: 'admin' as const,
        mobile: null,
        employee_id: null,
        territory: null,
        territory_city: null,
        manager: null,
      },
    });
  }

  const users = await crm.users();
  const user = await users.findOne({ _id: input.id });
  if (!user) throw AppError.unauthorized('Account not found');

  const territories = await crm.territories();
  const territory = user.territoryId ? await territories.findOne({ _id: user.territoryId }) : null;
  const manager = user.managerId ? await users.findOne({ _id: user.managerId }) : null;

  return ok({
    user: {
      ...shapeUser(user),
      territory: territory?.name ?? null,
      territory_city: territory?.city ?? null,
      manager: manager?.name ?? null,
    },
  });
}
