import { registerAs } from '@nestjs/config';

/**
 * Crypto exchange connectors. API credentials are encrypted at rest with
 * AES-256-GCM using CRYPTO_ENCRYPTION_KEY (32 raw bytes, base64), a key
 * dedicated to this feature. Keys are versioned so a later rotation can add
 * version 2 while rows encrypted under version 1 stay readable.
 */
export default registerAs('crypto', () => {
  const encryptionKeys: Record<number, string> = {};
  if (process.env.CRYPTO_ENCRYPTION_KEY) {
    encryptionKeys[1] = process.env.CRYPTO_ENCRYPTION_KEY;
  }
  return {
    encryptionKeys,
    currentKeyVersion: 1,
    syncIntervalMs: parseInt(process.env.CRYPTO_SYNC_INTERVAL_MS, 10) || 900000,
    allowedOrigin: process.env.CRYPTO_ALLOWED_ORIGIN || '',
  };
});
