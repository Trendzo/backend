import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;

export function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, SALT_ROUNDS);
}

export function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

/**
 * Generate a 12-char temp password for admin- or owner-initiated force resets.
 * Returned once to the caller; the cleartext is never stored. Alphabet excludes
 * visually-confusable characters (0/O, 1/l/I) so the manager can read it aloud.
 */
export function generateTempPassword(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
  let out = '';
  const buf = new Uint32Array(12);
  globalThis.crypto.getRandomValues(buf);
  for (const v of buf) out += alphabet[v % alphabet.length];
  return out;
}
