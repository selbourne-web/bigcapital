import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

const CODE_COUNT = 8;
// Excludes visually ambiguous characters (0/O, 1/I/L).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A fresh set of one-time recovery codes, formatted like `XXXX-XXXX`. */
export function generateRecoveryCodes(count = CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(8);
    const chars = Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]);
    return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}`;
  });
}

/** Hashes codes for storage; only the hashes are ever persisted. */
export async function hashRecoveryCodes(codes: string[]): Promise<string[]> {
  return Promise.all(codes.map((code) => bcrypt.hash(normalize(code), 10)));
}

/**
 * Checks a code against the stored hashes and, if it matches, returns the
 * remaining hashes with that one removed (codes are single-use).
 */
export async function consumeRecoveryCode(
  code: string,
  storedHashes: string[],
): Promise<{ matched: boolean; remaining: string[] }> {
  const normalized = normalize(code);

  for (let i = 0; i < storedHashes.length; i++) {
    if (await bcrypt.compare(normalized, storedHashes[i])) {
      return {
        matched: true,
        remaining: [...storedHashes.slice(0, i), ...storedHashes.slice(i + 1)],
      };
    }
  }
  return { matched: false, remaining: storedHashes };
}

const normalize = (code: string) => code.trim().toUpperCase();
