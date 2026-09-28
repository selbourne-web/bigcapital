import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '@liaoliaots/nestjs-redis';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { pkceCodeChallenge, randomUrlSafeToken } from './pkce';
import {
  evaluateMicrosoftSsoPolicy,
  MicrosoftIdTokenClaims,
} from './microsoft-sso-policy';
import { SystemUser } from '@/modules/System/models/SystemUser';

// Multi-tenant ("organizations") endpoints: any Microsoft Entra ID work or
// school account may reach the sign-in page; which ones are actually let in
// is decided afterwards by evaluateMicrosoftSsoPolicy (tenant id and, always,
// the email domain). Personal Microsoft accounts cannot use "organizations".
const AUTHORIZE_URL =
  'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize';
const TOKEN_URL =
  'https://login.microsoftonline.com/organizations/oauth2/v2.0/token';
const JWKS_URL =
  'https://login.microsoftonline.com/organizations/discovery/v2.0/keys';

const STATE_TTL_SECONDS = 10 * 60;
const EXCHANGE_CODE_TTL_SECONDS = 60;
const STATE_KEY_PREFIX = 'sso:ms:state:';
const EXCHANGE_KEY_PREFIX = 'sso:ms:exchange:';

interface PendingState {
  codeVerifier: string;
  nonce: string;
}

export type MicrosoftSsoSignInErrorReason =
  | 'not_configured'
  | 'invalid_state'
  | 'token_exchange_failed'
  | 'invalid_id_token'
  | 'no_email'
  | 'tenant_not_allowed'
  | 'domain_not_allowed'
  | 'no_account'
  | 'oid_mismatch'
  | 'no_workspace';

export class MicrosoftSsoSignInError extends Error {
  constructor(public readonly reason: MicrosoftSsoSignInErrorReason) {
    super(`Microsoft sign-in rejected: ${reason}`);
  }
}

const jwks = createRemoteJWKSet(new URL(JWKS_URL));

/**
 * "Sign in with Microsoft" for the company's own Entra ID tenant(s), with
 * PKCE and one-time state/nonce held in Redis. On success, links or reuses an
 * existing Bigcapital account by email; it never creates one - who gets an
 * account, and what they can do, stays an explicit admin decision.
 */
@Injectable()
export class MicrosoftSsoService {
  private readonly logger = new Logger(MicrosoftSsoService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly redisService: RedisService,
  ) {}

  public isConfigured(): boolean {
    return (
      !!this.config.get<boolean>('microsoftSso.enabled') &&
      !!this.config.get<string>('microsoftSso.clientId') &&
      !!this.config.get<string>('microsoftSso.clientSecret') &&
      !!this.config.get<string>('microsoftSso.redirectUri')
    );
  }

  /** Builds the URL to send the browser to, and stashes the PKCE/nonce state. */
  public async buildAuthorizationUrl(): Promise<string> {
    if (!this.isConfigured()) {
      throw new MicrosoftSsoSignInError('not_configured');
    }
    const codeVerifier = randomUrlSafeToken(48);
    const state = randomUrlSafeToken(24);
    const nonce = randomUrlSafeToken(24);

    await this.redisService
      .getOrThrow()
      .set(
        `${STATE_KEY_PREFIX}${state}`,
        JSON.stringify({ codeVerifier, nonce } satisfies PendingState),
        'EX',
        STATE_TTL_SECONDS,
      );

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', this.config.get('microsoftSso.clientId'));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set(
      'redirect_uri',
      this.config.get('microsoftSso.redirectUri'),
    );
    url.searchParams.set('response_mode', 'query');
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', pkceCodeChallenge(codeVerifier));
    url.searchParams.set('code_challenge_method', 'S256');
    // Always shows the account picker; avoids silently reusing whichever
    // Microsoft session happens to be active in the browser.
    url.searchParams.set('prompt', 'select_account');

    return url.toString();
  }

  /**
   * Handles the redirect back from Microsoft: verifies state, exchanges the
   * code, validates the id_token, and checks the claims against the allowed
   * tenants/domains. Returns a one-time code the webapp exchanges for a
   * normal sign-in.
   */
  public async handleCallback(
    code: string,
    state: string,
    findUserByEmail: (email: string) => Promise<SystemUser | null>,
    linkUser: (user: SystemUser, oid: string) => Promise<void>,
  ): Promise<string> {
    if (!this.isConfigured()) {
      throw new MicrosoftSsoSignInError('not_configured');
    }
    const redis = this.redisService.getOrThrow();
    const stateKey = `${STATE_KEY_PREFIX}${state}`;
    const pendingRaw = await redis.get(stateKey);
    if (!pendingRaw) {
      throw new MicrosoftSsoSignInError('invalid_state');
    }
    await redis.del(stateKey);
    const pending = JSON.parse(pendingRaw) as PendingState;

    const idToken = await this.exchangeCodeForIdToken(
      code,
      pending.codeVerifier,
    );
    const claims = await this.verifyIdToken(idToken, pending.nonce);

    const decision = evaluateMicrosoftSsoPolicy(claims, {
      allowedTenantIds: this.config.get<string[]>(
        'microsoftSso.allowedTenantIds',
      ),
      allowedDomains: this.config.get<string[]>('microsoftSso.allowedDomains'),
    });
    if (decision.allowed === false) {
      throw new MicrosoftSsoSignInError(decision.reason);
    }

    const user = await findUserByEmail(decision.email);
    if (!user) {
      throw new MicrosoftSsoSignInError('no_account');
    }
    if (user.microsoftOid && user.microsoftOid !== claims.oid) {
      // Already linked to a different Microsoft identity: never silently
      // relink, in case the email briefly matched a different account.
      this.logger.warn(`Microsoft sign-in oid mismatch for user ${user.id}`);
      throw new MicrosoftSsoSignInError('oid_mismatch');
    }
    if (!user.microsoftOid) {
      await linkUser(user, claims.oid);
    }

    const exchangeCode = randomUUID();
    await redis.set(
      `${EXCHANGE_KEY_PREFIX}${exchangeCode}`,
      String(user.id),
      'EX',
      EXCHANGE_CODE_TTL_SECONDS,
    );
    return exchangeCode;
  }

  /** Resolves a one-time exchange code (see {@link handleCallback}) to a user id, once. */
  public async resolveExchangeCode(code: string): Promise<number | null> {
    const redis = this.redisService.getOrThrow();
    const key = `${EXCHANGE_KEY_PREFIX}${code}`;
    const userId = await redis.get(key);
    if (!userId) return null;
    await redis.del(key);
    return Number(userId);
  }

  private async exchangeCodeForIdToken(
    code: string,
    codeVerifier: string,
  ): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.config.get('microsoftSso.clientId'),
      client_secret: this.config.get('microsoftSso.clientSecret'),
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.get('microsoftSso.redirectUri'),
      code_verifier: codeVerifier,
    });

    let response: Response;
    try {
      response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (error) {
      this.logger.error(
        `Microsoft token exchange request failed: ${error?.name}`,
      );
      throw new MicrosoftSsoSignInError('token_exchange_failed');
    }
    if (!response.ok) {
      // Never logs the response body: it can include client_secret-adjacent
      // error detail. The status is enough to diagnose from server logs.
      this.logger.warn(`Microsoft token exchange returned ${response.status}`);
      throw new MicrosoftSsoSignInError('token_exchange_failed');
    }
    const payload = (await response.json()) as { id_token?: string };
    if (!payload.id_token) {
      throw new MicrosoftSsoSignInError('token_exchange_failed');
    }
    return payload.id_token;
  }

  private async verifyIdToken(
    idToken: string,
    expectedNonce: string,
  ): Promise<MicrosoftIdTokenClaims> {
    const clientId = this.config.get<string>('microsoftSso.clientId');
    let claims: MicrosoftIdTokenClaims;
    try {
      const { payload } = await jwtVerify(idToken, jwks, {
        audience: clientId,
      });
      claims = payload as unknown as MicrosoftIdTokenClaims;
    } catch (error) {
      this.logger.warn(
        `Microsoft id_token verification failed: ${error?.name}`,
      );
      throw new MicrosoftSsoSignInError('invalid_id_token');
    }
    // jose checks signature/expiry/audience; the issuer still needs to match
    // the tenant the token itself claims (jose can't know that in advance),
    // and the nonce ties this token to the authorize request we started.
    const issuerTenant =
      /^https:\/\/login\.microsoftonline\.com\/([^/]+)\/v2\.0$/.exec(
        claims.iss ?? '',
      )?.[1];
    if (!issuerTenant || issuerTenant !== claims.tid) {
      throw new MicrosoftSsoSignInError('invalid_id_token');
    }
    if (claims.nonce !== expectedNonce) {
      throw new MicrosoftSsoSignInError('invalid_id_token');
    }
    return claims;
  }
}
