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
