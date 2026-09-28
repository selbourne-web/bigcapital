import { authenticator } from 'otplib';
import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '@liaoliaots/nestjs-redis';
import { randomUUID } from 'crypto';
import { decryptSecret, encryptSecret } from './mfa-secret-crypto';
import {
  consumeRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCodes,
} from './recovery-codes';
import { SystemUser } from '@/modules/System/models/SystemUser';

/** A newly-generated secret waiting for the person to prove they hold it. */
interface PendingEnrollment {
  userId: number;
  secret: string;
}

const PENDING_ENROLLMENT_TTL_SECONDS = 10 * 60;
const REDIS_KEY_PREFIX = 'mfa:pending-enrollment:';

/** The error body shape the webapp already understands (see receipt autofill). */
const failure = (type: string, message: string) => ({
  errors: [{ type, message }],
});

/**
 * App-based (TOTP) two-factor authentication: the fallback for any sign-in
 * that does not go through Microsoft SSO. Secrets are encrypted at rest;
 * verification allows a one-step clock drift either way.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly config: ConfigService,
    private readonly redisService: RedisService,
    @Inject(SystemUser.name)
    private readonly systemUserModel: typeof SystemUser,
  ) {
    authenticator.options = { window: 1 };
  }

  /** Whether an encryption key is configured; without one MFA is switched off. */
  public isConfigured(): boolean {
    return !!this.encryptionKey(false);
  }

  private encryptionKey(required = true): string {
    const key = this.config.get<string>('mfa.encryptionKey');
    if (!key && required) {
      throw new ServiceUnavailableException(
        failure(
          'MFA_NOT_CONFIGURED',
          'Two-factor authentication is not set up. An administrator needs to add an encryption key to the server settings.',
        ),
      );
    }
    return key;
  }

  /**
   * Starts enrollment: generates a secret, holds it in Redis (not yet on the
   * user) until {@link enable} proves the person can generate a matching code.
   */
  public async startEnrollment(
    userId: number,
    accountEmail: string,
  ): Promise<{ secret: string; otpauthUrl: string }> {
    // Fails fast if MFA isn't configured; encryption itself happens once
    // enrollment is confirmed, in `enable`.
    this.encryptionKey();
    const secret = authenticator.generateSecret();
    const issuer = this.config.get<string>('mfa.issuer');

    await this.redisService
      .getOrThrow()
      .set(
        `${REDIS_KEY_PREFIX}${userId}`,
        JSON.stringify({ userId, secret } satisfies PendingEnrollment),
        'EX',
        PENDING_ENROLLMENT_TTL_SECONDS,
      );

    return {
      secret,
      otpauthUrl: authenticator.keyuri(accountEmail, issuer, secret),
    };
  }

  /**
   * Confirms enrollment: the person must produce a valid code from the secret
   * issued by {@link startEnrollment}. Persists the encrypted secret and a
   * fresh set of recovery codes (returned once, in plain text).
   */
  public async enable(
    userId: number,
    token: string,
  ): Promise<{ recoveryCodes: string[] }> {
    const key = this.encryptionKey();
    const pendingRaw = await this.redisService
      .getOrThrow()
      .get(`${REDIS_KEY_PREFIX}${userId}`);
    if (!pendingRaw) {
      throw new ServiceUnavailableException(
        failure(
          'MFA_ENROLLMENT_EXPIRED',
          'That code took too long to arrive. Start setup again.',
        ),
      );
    }
    const pending = JSON.parse(pendingRaw) as PendingEnrollment;
    if (!authenticator.check(token, pending.secret)) {
      throw new ServiceUnavailableException(
        failure('MFA_INVALID_CODE', 'That code is not correct.'),
      );
    }
    await this.redisService.getOrThrow().del(`${REDIS_KEY_PREFIX}${userId}`);

    const recoveryCodes = generateRecoveryCodes();
    const recoveryCodeHashes = await hashRecoveryCodes(recoveryCodes);

    await this.systemUserModel
      .query()
      .findById(userId)
      .patch({
        mfaSecret: encryptSecret(pending.secret, key),
        mfaEnabled: true,
        mfaEnrolledAt: new Date().toISOString(),
        mfaRecoveryCodes: JSON.stringify(recoveryCodeHashes),
      } as Partial<SystemUser>);

    return { recoveryCodes };
  }

  /** Turns MFA off for the account; the caller has already proven the token. */
  public async disable(userId: number): Promise<void> {
    await this.systemUserModel
      .query()
      .findById(userId)
      .patch({
        mfaSecret: null,
        mfaEnabled: false,
        mfaEnrolledAt: null,
        mfaRecoveryCodes: null,
      } as Partial<SystemUser>);
  }

  /** Verifies a 6-digit TOTP code against the user's stored, decrypted secret. */
  public async verifyToken(user: SystemUser, token: string): Promise<boolean> {
    if (!user.mfaEnabled || !user.mfaSecret) return false;
    const secret = decryptSecret(user.mfaSecret, this.encryptionKey());
    return authenticator.check(token, secret);
  }

  /**
   * Verifies and consumes a recovery code, replacing the stored hash list so
   * the same code cannot be used twice.
   */
  public async verifyAndConsumeRecoveryCode(
    user: SystemUser,
    code: string,
  ): Promise<boolean> {
    if (!user.mfaEnabled || !user.mfaRecoveryCodes) return false;
    const hashes = JSON.parse(user.mfaRecoveryCodes) as string[];
    const { matched, remaining } = await consumeRecoveryCode(code, hashes);
    if (!matched) return false;

    await this.systemUserModel
      .query()
      .findById(user.id)
      .patch({
        mfaRecoveryCodes: JSON.stringify(remaining),
      } as Partial<SystemUser>);
    return true;
  }

  /** A short-lived, single-use marker for a login challenge, held in Redis. */
  public async issueLoginChallenge(userId: number): Promise<string> {
    const challengeId = randomUUID();
    await this.redisService
      .getOrThrow()
      .set(`mfa:login-challenge:${challengeId}`, String(userId), 'EX', 5 * 60);
    return challengeId;
  }

  /** Resolves a login-challenge id to the user id it was issued for, once. */
  public async resolveLoginChallenge(
    challengeId: string,
  ): Promise<number | null> {
    const client = this.redisService.getOrThrow();
    const key = `mfa:login-challenge:${challengeId}`;
    const userId = await client.get(key);
    if (!userId) return null;
    await client.del(key);
    return Number(userId);
  }
}
