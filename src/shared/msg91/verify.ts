import { env } from '@/config/env.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { normalizeIntlPhone } from '@/shared/validation/common.js';

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
 * Verify an MSG91 widget access token and return the verified phone number.
 *
 * `format` selects the shape of the returned number:
 *  - `'national'` (default) — 10-digit national number (India). Used by consumer login,
 *    whose stored phones are 10-digit. Unchanged behaviour.
 *  - `'e164'` — canonical E.164 (`+<country><number>`), preserving the country code. Used
 *    by retailer login, which serves an international audience.
 *
 * `authKey` picks which MSG91 account authkey to verify against — consumer and retailer
 * widgets live under different accounts. Defaults to the consumer key (`MSG91_AUTH_KEY`).
 *
 * @throws AppError 503 when the chosen authkey is unset, 401 when the token is invalid.
 */
export async function verifyMsg91AccessToken(
  accessToken: string,
  opts?: { format?: 'national' | 'e164'; authKey?: string },
): Promise<string> {
  const authKey = opts?.authKey ?? env.MSG91_AUTH_KEY;
  if (!authKey) {
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
      headers: { 'Content-Type': 'application/json', authkey: authKey },
      body: JSON.stringify({ 'access-token': accessToken }),
    });
    data = (await res.json()) as { type?: string; message?: string };
  } catch {
    throw new AppError(502, ErrorCode.InternalError, 'Could not reach the OTP provider');
  }

  if (data.type !== 'success' || !data.message) {
    throw new AppError(401, ErrorCode.InvalidCredentials, 'OTP verification failed');
  }

  // MSG91 returns the verified identifier with country code (e.g. "919876543210").
  if (opts?.format === 'e164') {
    const e164 = normalizeIntlPhone(String(data.message));
    if (!e164) {
      throw new AppError(401, ErrorCode.InvalidCredentials, 'OTP verification failed');
    }
    return e164;
  }
  // Default: keep the 10-digit national part (India — consumer login).
  const national = String(data.message).replace(/\D/g, '').slice(-10);
  if (national.length !== 10) {
    throw new AppError(401, ErrorCode.InvalidCredentials, 'OTP verification failed');
  }
  return national;
}
