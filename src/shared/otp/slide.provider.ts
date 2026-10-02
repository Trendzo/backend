import { env } from '@/config/env.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import type { OtpProvider } from './types.js';

/**
 * Slide (Synquic) OTP, server-side half.
 *
 * Clients talk to Slide's PUBLIC endpoints (shared/otp/config.ts documents them) with the
 * public widget id + client token, and receive a short-lived, single-use JWT access token.
 * That token is NOT trusted as-is: this re-verifies it with the secret SLIDE_API_KEY via
 * POST {base}/otp/verify-token, which also consumes it.
 *
 * The reply is `{verified, identifier, verifiedAt}` in Slide's docs and
 * `{valid, identifier, widgetId, verifiedAt}` in the dashboard's integration snippet, so
 * both spellings are accepted; when `widgetId` is present it must be OUR widget.
 */
const TIMEOUT_MS = 8_000;

type VerifyReply = {
  valid?: boolean;
  verified?: boolean;
  identifier?: string;
  widgetId?: string;
  message?: string;
};

const invalid = () => new AppError(401, ErrorCode.InvalidCredentials, 'OTP verification failed');

export const slideProvider: OtpProvider = {
  name: 'slide',
  async verifyAccessToken(accessToken) {
    if (!env.SLIDE_API_KEY) {
      throw new AppError(
        503,
        ErrorCode.InternalError,
        'OTP verification is not configured (missing Slide credentials).',
      );
    }

    let status: number;
    let data: VerifyReply;
    try {
      const res = await fetch(`${env.SLIDE_API_BASE_URL.replace(/\/+$/, '')}/otp/verify-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.SLIDE_API_KEY}`,
        },
        body: JSON.stringify({ accessToken }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = res.status;
      data = (await res.json()) as VerifyReply;
    } catch {
      throw new AppError(502, ErrorCode.InternalError, 'Could not reach the OTP provider');
    }

    // Our OWN key being rejected is a deployment problem, not a user typing a wrong code:
    // surface it as "not configured" and log it, instead of reporting every login as invalid.
    if (status === 401 && /api key|authorization/i.test(data?.message ?? '')) {
      console.error(`[slide] verify-token rejected our API key: ${JSON.stringify(data)}`);
      throw new AppError(
        503,
        ErrorCode.InternalError,
        'OTP verification is not configured (Slide credentials rejected).',
      );
    }
    if (status >= 500) {
      throw new AppError(502, ErrorCode.InternalError, 'Could not reach the OTP provider');
    }

    const ok = data?.valid === true || data?.verified === true;
    if (status >= 400 || !ok || typeof data.identifier !== 'string' || !data.identifier) {
      console.error(`[slide] verify-token rejected (HTTP ${status}): ${JSON.stringify(data)}`);
      throw invalid();
    }
    if (data.widgetId && env.SLIDE_WIDGET_ID && data.widgetId !== env.SLIDE_WIDGET_ID) {
      // A valid token, but minted by another widget/tenant: not ours to trust.
      console.error('[slide] verify-token accepted a token from a different widget');
      throw invalid();
    }
    // Slide returns E.164 with '+'; the shared formatter wants digits incl. country code.
    return data.identifier.replace(/\D/g, '');
  },
};
