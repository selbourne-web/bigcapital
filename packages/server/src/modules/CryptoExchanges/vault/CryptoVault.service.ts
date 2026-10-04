import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  decryptSecret,
  encryptSecret,
} from '@/modules/Auth/mfa/mfa-secret-crypto';

interface CryptoConfig {
  encryptionKeys: Record<number, string>;
  currentKeyVersion: number;
}

/**
 * Encrypts exchange API credentials at rest (AES-256-GCM, versioned key).
 * Fails fast at construction when CRYPTO_ENCRYPTION_KEY is missing or invalid
 * so the app never runs able to store credentials unprotected.
 */
@Injectable()
export class CryptoVault {
  private readonly keys: Record<number, string>;
  private readonly currentVersion: number;

  constructor(configService: ConfigService) {
    const config = configService.get<CryptoConfig>('crypto');
    this.keys = config?.encryptionKeys ?? {};
    this.currentVersion = config?.currentKeyVersion ?? 1;

    const current = this.keys[this.currentVersion];
    if (!current) {
      throw new Error(
        'CRYPTO_ENCRYPTION_KEY is not set (openssl rand -base64 32).',
      );
    }
    if (Buffer.from(current, 'base64').length !== 32) {
      throw new Error(
        'CRYPTO_ENCRYPTION_KEY must decode to exactly 32 bytes (openssl rand -base64 32).',
      );
    }
  }

  encrypt(plain: string): { value: string; keyVersion: number } {
    return {
      value: encryptSecret(plain, this.keys[this.currentVersion]),
      keyVersion: this.currentVersion,
    };
  }

  decrypt(value: string, keyVersion: number): string {
    const key = this.keys[keyVersion];
    if (!key) {
      throw new Error();
    }
    return decryptSecret(value, key);
  }
}
