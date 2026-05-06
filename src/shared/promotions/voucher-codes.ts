import { randomInt } from 'node:crypto';

/**
 * Voucher-code character set: 32 chars excluding visually ambiguous ones (0/O, 1/I/L).
 * 8 chars from this alphabet → ~1.1×10^12 possibilities. Plenty of headroom; collisions
 * are vanishingly rare but the API layer still does a unique-index retry loop.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const DEFAULT_LEN = 8;

/**
 * Generate `count` distinct codes (deduped within this call). Optional uppercase prefix
 * is concatenated as-is; the random tail uses ALPHABET. The DB still owns global
 * uniqueness — handlers must catch 23505 and re-roll the colliding code.
 */
export function generateCodes(count: number, prefix = ''): string[] {
  if (count <= 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  // Loop with a generous safety bound — at 32^8 possibilities, retries should be < 1%.
  let safety = count * 16;
  while (out.length < count && safety > 0) {
    safety -= 1;
    const code = prefix + randomCode(DEFAULT_LEN);
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  if (out.length !== count) {
    throw new Error(`voucher-code generator could not produce ${count} unique codes`);
  }
  return out;
}

function randomCode(len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return s;
}
