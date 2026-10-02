import { env } from '@/config/env.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { formatVerifiedPhone } from '@/shared/otp/format.js';

/**
 * MSG91 OTP-widget server-side verification.
 *
 * The mobile app drives the OTP send/verify against MSG91's widget REST API directly
 * (using the public widgetId/tokenAuth pair) and receives a short-lived access token.
 * That token is NOT trusted as-is — this helper re-verifies it against MSG91 using the
 * secret MSG91_AUTH_KEY and returns the phone number MSG91 attests was verified.
 */
const VERIFY_URL = 'https://control.msg91.com/api/v5/widget/verifyAccessToken';

/**
 * Verify an MSG91 widget access token and return the verified phone as digits INCLUDING the
 * country code (MSG91's own form, e.g. "919876543210").
 *
 * `authKey` picks which MSG91 account authkey to verify against — consumer and retailer
 * widgets live under different accounts. Defaults to the consumer key (`MSG91_AUTH_KEY`).
 *
 * @throws AppError 503 when the chosen authkey is unset, 502 when MSG91 is unreachable,
 *   401 when the token is invalid.
 */
export async function verifyMsg91Digits(accessToken: string, authKey?: string): Promise<string> {
  const key = authKey ?? env.MSG91_AUTH_KEY;
  if (!key) {
    throw new AppError(
      503,
      ErrorCode.InternalError,
      'OTP verification is not configured (missing MSG91 credentials).',
    );
  }

  let data: { type?: string; message?: string };
  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authkey: key },
      body: JSON.stringify({ 'access-token': accessToken }),
    });
    data = (await res.json()) as { type?: string; message?: string };
  } catch {
    throw new AppError(502, ErrorCode.InternalError, 'Could not reach the OTP provider');
  }

  if (data.type !== 'success' || !data.message) {
    // Log what MSG91 actually said, plus the account the authkey belongs to. A cross-account
    // mismatch (app's widget minted the token under account A, we verify with account B's
    // authkey) is rejected exactly like a wrong OTP, so without this line the two are
    // indistinguishable and every failure looks like "user typed the wrong code".
    // Only the account id is logged — it is the public prefix of the widget tokenAuth, not
    // the secret key.
    console.error(
      `[msg91] verifyAccessToken rejected (account ${key.slice(0, 6)}): ` +
        `${JSON.stringify(data)}`,
    );
    throw new AppError(401, ErrorCode.InvalidCredentials, 'OTP verification failed');
  }
  return String(data.message);
}

/**
 * Verify an MSG91 widget access token and return the verified phone number.
 *
 * `format` selects the shape of the returned number:
 *  - `'national'` (default) — 10-digit national number (India). Used by consumer login,
 *    whose stored phones are 10-digit. Unchanged behaviour.
 *  - `'e164'` — canonical E.164 (`+<country><number>`), preserving the country code. Used
 *    by retailer login, which serves an international audience.
 *
 * Login controllers go through `verifyOtpPhone` (shared/otp), which picks the provider;
 * this stays for MSG91-only callers.
 */
export async function verifyMsg91AccessToken(
  accessToken: string,
  opts?: { format?: 'national' | 'e164'; authKey?: string },
): Promise<string> {
  return formatVerifiedPhone(
    await verifyMsg91Digits(accessToken, opts?.authKey),
    opts?.format ?? 'national',
  );
}
