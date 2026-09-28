import { parseBoolean } from '@/utils/parse-boolean';
import { registerAs } from '@nestjs/config';

/**
 * TOTP (app-based) two-factor authentication, used as the fallback for any
 * sign-in that does not go through Microsoft SSO.
 */
export default registerAs('mfa', () => ({
  // AES-256-GCM key, 32 raw bytes as base64. Generate with:
  //   openssl rand -base64 32
  encryptionKey: process.env.MFA_ENCRYPTION_KEY || undefined,
  issuer: process.env.MFA_ISSUER || 'Selbourne Financial',
  // Once true, password sign-in requires TOTP: an account without it set up
  // yet is walked through enrollment as part of that sign-in. Leave off
  // until Microsoft SSO (or an existing account's 2FA) has been verified
  // working, so a bug here cannot lock out the only account.
  requireForPassword: parseBoolean<boolean>(
    process.env.AUTH_REQUIRE_MFA_FOR_PASSWORD,
    false,
  ),
}));
