import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { normalizeIntlPhone } from '@/shared/validation/common.js';
import type { OtpPhoneFormat } from './types.js';

const verificationFailed = () =>
  new AppError(401, ErrorCode.InvalidCredentials, 'OTP verification failed');

/**
 * Turn the verified digits-with-country-code a provider attests into the shape a login
 * expects: `'e164'` keeps the country code (`+<country><number>`, retailer/driver);
 * `'national'` keeps the last 10 digits (India — consumer login, CRM).
 */
export function formatVerifiedPhone(digitsWithCountryCode: string, format: OtpPhoneFormat): string {
  if (format === 'e164') {
    const e164 = normalizeIntlPhone(digitsWithCountryCode);
    if (!e164) throw verificationFailed();
    return e164;
  }
  const national = digitsWithCountryCode.replace(/\D/g, '').slice(-10);
  if (national.length !== 10) throw verificationFailed();
  return national;
}
