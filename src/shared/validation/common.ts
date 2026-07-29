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

/**
 * Every money and stock column these guard is Postgres `integer` (int4). Without an
 * upper bound a value above int4 range passed validation, reached the INSERT, and
 * came back as an unhandled pg 22003 — a bare 500 with no hint at which field was
 * wrong. Bounding here turns that into a 422 naming the field.
 *
 * INT4_MAX paise is ₹2,14,74,836.47 per line, which is far above any real listing.
 */
const INT4_MAX = 2_147_483_647;

/** Money in paise — non-negative integer that fits the int4 column. */
export const PaiseSchema = z
  .number()
  .int()
  .nonnegative()
  .max(INT4_MAX, 'Amount is too large');

/** Strictly positive paise (used for prices). */
export const PositivePaiseSchema = z
  .number()
  .int()
  .positive()
  .max(INT4_MAX, 'Amount is too large');

/** Stock count — non-negative integer that fits the int4 column. */
export const StockSchema = z
  .number()
  .int()
  .nonnegative()
  .max(INT4_MAX, 'Stock count is too large');
