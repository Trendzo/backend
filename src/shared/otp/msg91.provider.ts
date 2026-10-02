import { env } from '@/config/env.js';
import { verifyMsg91Digits } from '@/shared/msg91/verify.js';
import type { OtpAudience, OtpProvider } from './types.js';

/**
 * MSG91 keeps one account (authkey) per widget family: a token issued by one account only
 * verifies against that account's authkey. The sales CRM reuses the retailer web widget.
 */
function authKeyFor(audience: OtpAudience): string | undefined {
  switch (audience) {
    case 'consumer':
      return env.MSG91_AUTH_KEY;
    case 'driver':
      return env.MSG91_DRIVER_AUTH_KEY ?? env.MSG91_RETAILER_AUTH_KEY;
    case 'retailer':
    case 'crm':
      return env.MSG91_RETAILER_AUTH_KEY;
  }
}

export const msg91Provider: OtpProvider = {
  name: 'msg91',
  async verifyAccessToken(accessToken, audience) {
    // An unset key makes verifyMsg91Digits throw the 503 "not configured" error, so a
    // missing authkey is reported before any network call, exactly as before.
    return verifyMsg91Digits(accessToken, authKeyFor(audience) ?? '');
  },
};
