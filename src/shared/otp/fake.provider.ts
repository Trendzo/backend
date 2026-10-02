import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import type { OtpProvider } from './types.js';

/**
 * Test-only provider (OTP_PROVIDER=fake, refused in production by the env schema).
 * A token is `fake:<phone>` (optionally `:<padding>` to reach the 20-char minimum real
 * tokens always exceed) and verifies to that phone; anything else is rejected.
 */
export const fakeProvider: OtpProvider = {
  name: 'fake',
  async verifyAccessToken(accessToken) {
    const m = /^fake:\+?(\d{10,15})(?::.*)?$/.exec(accessToken);
    if (!m) throw new AppError(401, ErrorCode.InvalidCredentials, 'OTP verification failed');
    return m[1] as string;
  },
};
