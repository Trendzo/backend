import { z } from 'zod';

/**
 * GSTIN — relaxed for MVP. Real format is 2-digit state + 10-char PAN + 1-digit entity +
 * 'Z' + 1 alphanumeric checksum, but enforcing it makes early testing painful. We accept
 * any 15-character uppercase string for now and tighten later when we wire real KYC.
 */
export const GstinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(15, 'GSTIN must be exactly 15 characters');

/** Indian phone number — accepts 10 digits or +91 prefix. */
export const PhoneSchema = z
  .string()
  .trim()
  .regex(/^(\+91)?[6-9][0-9]{9}$/, 'Invalid phone number');

/**
 * Normalise an international phone number to canonical E.164 (`+<country><number>`).
 * The frontend supplies the country code, so input already carries it; we strip any
 * spaces/dashes/parens, keep a single leading `+`, and validate 8–15 total digits.
 * Returns `null` when the result is not a valid E.164 number.
 */
export function normalizeIntlPhone(raw: string): string | null {
  const e164 = '+' + raw.replace(/\D/g, '');
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
}

/**
 * International phone number stored as canonical E.164. Used for retailer-owned phones
 * (signup / onboarding / admin-created owner accounts) so phone-OTP login can match the
 * exact stored value. Consumer flows keep the India-only {@link PhoneSchema}.
 */
export const IntlPhoneSchema = z
  .string()
  .trim()
  .transform((raw, ctx) => {
    const e164 = normalizeIntlPhone(raw);
    if (!e164) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid phone number' });
      return z.NEVER;
    }
    return e164;
  });

/** Email — normalised to lowercase. */
export const EmailSchema = z.string().trim().toLowerCase().email('Invalid email');

/** Password — min 4 chars per frontend contract. */
export const PasswordSchema = z.string().min(4, 'Password must be at least 4 characters').max(72);

/** State code — 2 alpha-numeric chars (matches GSTIN's first 2 digits in practice). */
export const StateCodeSchema = z.string().trim().regex(/^[0-9]{2}$/, 'State code must be 2 digits');

/** Money in paise — non-negative integer. */
export const PaiseSchema = z.number().int().nonnegative();

/** Strictly positive paise (used for prices). */
export const PositivePaiseSchema = z.number().int().positive();

/** Stock count — non-negative integer. */
export const StockSchema = z.number().int().nonnegative();
