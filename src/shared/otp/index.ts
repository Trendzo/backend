import { env } from '@/config/env.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { fakeProvider } from './fake.provider.js';
import { formatVerifiedPhone } from './format.js';
import { msg91Provider } from './msg91.provider.js';
import { slideProvider } from './slide.provider.js';
import type { OtpAudience, OtpPhoneFormat, OtpProvider, OtpProviderName } from './types.js';

export type { OtpAudience, OtpPhoneFormat, OtpProvider, OtpProviderName } from './types.js';

/**
 * OTP provider facade — the single seam the login controllers use.
 *
 * Which provider's tokens are accepted is OTP_PROVIDER (clients learn it from
 * GET /auth/otp-config). Rollouts are gradual, so while another provider is active a
 * token may still come from an app build that predates the switch: those send no
 * `provider` tag and are MSG91 tokens, so an UNTAGGED token is verified as MSG91 while
 * OTP_ACCEPT_LEGACY_MSG91 is on, otherwise by the active provider.
 */
const providers: Record<OtpProviderName, OtpProvider> = {
  msg91: msg91Provider,
  slide: slideProvider,
  fake: fakeProvider,
};

/** Providers a token may be verified by right now. */
export function acceptedProviders(): OtpProviderName[] {
  const active = env.OTP_PROVIDER;
  return active !== 'msg91' && env.OTP_ACCEPT_LEGACY_MSG91 === 'true'
    ? [active, 'msg91']
    : [active];
}

function pickProvider(tag: OtpProviderName | undefined): OtpProvider {
  if (tag === undefined) {
    // Untagged = a build that only knows MSG91.
    return providers[
      env.OTP_PROVIDER !== 'msg91' && env.OTP_ACCEPT_LEGACY_MSG91 === 'true'
        ? 'msg91'
        : env.OTP_PROVIDER
    ];
  }
  if (!acceptedProviders().includes(tag)) {
    throw new AppError(
      422,
      ErrorCode.ValidationError,
      `OTP provider "${tag}" is not accepted by this server`,
    );
  }
  return providers[tag];
}

/**
 * Verify a client's OTP access token and return the verified phone, shaped for the login
 * (`'e164'` keeps the country code, `'national'` is the 10-digit Indian number).
 *
 * @throws AppError 503 provider not configured, 502 provider unreachable, 401 invalid token,
 *   422 provider tag not accepted.
 */
export async function verifyOtpPhone(
  accessToken: string,
  opts: { audience: OtpAudience; format: OtpPhoneFormat; provider?: OtpProviderName | undefined },
): Promise<string> {
  const digits = await pickProvider(opts.provider).verifyAccessToken(accessToken, opts.audience);
  return formatVerifiedPhone(digits, opts.format);
}
