import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

/**
 * Encrypts a TOTP secret (or a recovery-code blob) at rest with AES-256-GCM.
 * The key comes from `MFA_ENCRYPTION_KEY` (32 raw bytes, base64) - never from
 * code. Each call uses a fresh random IV; the IV and the auth tag travel with
 * the ciphertext so decryption needs only the stored string and the key.
 */
export function encryptSecret(plainText: string, base64Key: string): string {
  const key = decodeKey(base64Key);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plainText, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [iv, authTag, ciphertext]
    .map((part) => part.toString('base64'))
    .join('.');
}

/** The inverse of {@link encryptSecret}. Throws if the key or value is wrong. */
export function decryptSecret(stored: string, base64Key: string): string {
  const key = decodeKey(base64Key);
  const [ivB64, authTagB64, ciphertextB64] = stored.split('.');
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error('Malformed encrypted value.');
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

function decodeKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) {
    throw new Error(
      'MFA_ENCRYPTION_KEY must decode to exactly 32 bytes (openssl rand -base64 32).',
    );
  }
  return key;
}
