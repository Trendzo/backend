import { env } from '@/config/env.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';

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
 * Verify an MSG91 widget access token and return the verified phone number as the
 * 10-digit national number (MSG91 reports it as `91XXXXXXXXXX` for India).
 *
 * @throws AppError 503 when MSG91_AUTH_KEY is unset, 401 when the token is invalid.
 */
export async function verifyMsg91AccessToken(accessToken: string): Promise<string> {
  if (!env.MSG91_AUTH_KEY) {
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
      headers: { 'Content-Type': 'application/json', authkey: env.MSG91_AUTH_KEY },
      body: JSON.stringify({ 'access-token': accessToken }),
    });
    data = (await res.json()) as { type?: string; message?: string };
  } catch {
    throw new AppError(502, ErrorCode.InternalError, 'Could not reach the OTP provider');
  }

  if (data.type !== 'success' || !data.message) {
    throw new AppError(401, ErrorCode.InvalidCredentials, 'OTP verification failed');
  }

  // MSG91 returns the verified identifier (e.g. "919876543210"); keep the national part.
  const national = String(data.message).replace(/\D/g, '').slice(-10);
  if (national.length !== 10) {
    throw new AppError(401, ErrorCode.InvalidCredentials, 'OTP verification failed');
  }
  return national;
}
