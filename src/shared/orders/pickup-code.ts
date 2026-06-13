import { randomBytes } from 'node:crypto';

/**
 * 32-char alphabet excluding visually-ambiguous glyphs (0/O, 1/I/L). Crockford-style
 * base32. Codes are read aloud at the store front so legibility matters.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const CODE_LENGTH = 6;

/**
 * Generates a 6-char pickup handover code. Stored on `orders.pickup_code` for pickup
 * delivery method only; verified by the retailer when the consumer arrives.
 *
 * Uniqueness is enforced by a partial unique index on `(store_id, pickup_code)` scoped
 * to active orders; the caller should retry generation on a `23505` conflict.
 */
export function generatePickupCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

/**
 * 6-digit numeric delivery OTP. Stored on `orders.delivery_otp` for door deliveries
 * (express/standard/try-and-buy); the consumer reads it to the agent, who supplies it
 * on door close. Numeric (not base32) because it's spoken over a doorstep handover.
 */
export function generateDeliveryOtp(): string {
  const bytes = randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += String(bytes[i]! % 10);
  }
  return out;
}
