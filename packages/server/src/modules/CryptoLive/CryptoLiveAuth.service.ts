import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ClsService } from 'nestjs-cls';
import { SystemUser } from '../System/models/SystemUser';
import { TenantModel } from '../System/models/TenantModel';
import { UserTenant } from '../System/models/UserTenant.model';
import { JWT_AUDIENCE, JWT_ISSUER } from '../Auth/Auth.constants';
import { TenantModelProxy } from '../System/models/TenantBaseModel';
import { TenantUser } from '../Tenancy/TenancyModels/models/TenantUser.model';
import {
  cacheAbility,
  getAbilityForRole,
  getCachedAbility,
} from '../Roles/TenantAbilities';
import { AbilitySubject } from '../Roles/Roles.types';
import { CryptoExchangeAction } from '../CryptoExchanges/CryptoExchanges.constants';

/** Rejection category. Logged and tested; the client only ever sees "unauthorized". */
export type CryptoLiveRejection =
  | 'bad-handshake'
  | 'origin'
  | 'invalid-token'
  | 'token-expired'
  | 'user-not-found'
  | 'organization-not-found'
  | 'not-member'
  | 'forbidden'
  | 'too-many-connections';

export class CryptoLiveAuthError extends Error {
  constructor(readonly category: CryptoLiveRejection) {
    // The message is the category only: never the token or any handshake data.
    super(category);
    this.name = 'CryptoLiveAuthError';
  }
}

export interface CryptoLiveIdentity {
  userId: number;
  tenantId: number;
  /** Organization id as stored on the tenant (canonical spelling, not the client's). */
  organizationId: string;
  /** Token expiry, epoch milliseconds. */
  expiresAt: number;
}

/**
 * Authenticates a socket handshake exactly as the REST layer authenticates a request:
 * the JWT is verified like `JwtStrategy` (HS384, same secret, issuer and audience), the
 * user must exist like `AuthSigninService.verifyPayload`, and the user must be a member
 * of the requested organization like `TenancyGlobalGuard` (tenant by `organizationId`,
 * then a `user_tenants` row for `{ userId, tenantId }`). It also requires the
 * `View` ability on `CryptoExchange`, resolved from the user's tenant role exactly like
 * `AuthorizationGuard` (same ability builder and cache), so the live channel is gated
 * by the same permission as the REST endpoints it mirrors. Abilities are checked at
 * handshake only; a role change applies from the next (re)connect, bounded by the
 * token expiry the gateway already enforces.
 */
@Injectable()
export class CryptoLiveAuth {
  private readonly jwt: JwtService;

  constructor(
    configService: ConfigService,
    @Inject(SystemUser.name)
    private readonly systemUserModel: typeof SystemUser,
    @Inject(TenantModel.name)
    private readonly tenantModel: typeof TenantModel,
    @Inject(UserTenant.name)
    private readonly userTenantModel: typeof UserTenant,
    private readonly cls: ClsService,
    @Inject(TenantUser.name)
    private readonly tenantUserModel: TenantModelProxy<typeof TenantUser>,
  ) {
    const secret = configService.get<string>('jwt.secret');
    if (!secret) {
      throw new Error(
        'APP_JWT_SECRET is not configured; the crypto live gateway refuses to verify tokens without it.',
      );
    }
    this.jwt = new JwtService({ secret });
  }

  async authenticate(
    token: string,
    organizationId: string,
  ): Promise<CryptoLiveIdentity> {
    let payload: { sub?: unknown; exp?: unknown };
    try {
      payload = await this.jwt.verifyAsync(token, {
        algorithms: ['HS384'],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        ignoreExpiration: false,
      });
    } catch (error) {
      throw new CryptoLiveAuthError(
        (error as Error)?.name === 'TokenExpiredError'
          ? 'token-expired'
          : 'invalid-token',
      );
    }
    const userId = Number(payload.sub);
    if (
      !Number.isInteger(userId) ||
      userId <= 0 ||
      typeof payload.exp !== 'number'
    ) {
      throw new CryptoLiveAuthError('invalid-token');
    }

    const user = await this.systemUserModel.query().findOne({ id: userId });
    if (!user) throw new CryptoLiveAuthError('user-not-found');

    const tenant = await this.tenantModel.query().findOne({ organizationId });
    if (!tenant) throw new CryptoLiveAuthError('organization-not-found');

    const membership = await this.userTenantModel
      .query()
      .findOne({ userId, tenantId: tenant.id });
    if (!membership) throw new CryptoLiveAuthError('not-member');

    if (!(await this.canViewCrypto(tenant.organizationId, userId))) {
      throw new CryptoLiveAuthError('forbidden');
    }

    return {
      userId,
      tenantId: tenant.id,
      organizationId: tenant.organizationId,
      expiresAt: payload.exp * 1000,
    };
  }

  /**
   * Whether the user's tenant role grants `View` on `CryptoExchange`. The tenant model
   * proxy resolves the tenant database from the CLS `organizationId`, so the lookup runs
   * in its own CLS context (the socket middleware has none). Fails closed: a missing
   * tenant user (or any lookup error, which propagates) never yields access.
   */
  private async canViewCrypto(
    organizationId: string,
    userId: number,
  ): Promise<boolean> {
    const cached = getCachedAbility(organizationId, userId);
    if (cached) {
      return cached.can(
        CryptoExchangeAction.View,
        AbilitySubject.CryptoExchange,
      );
    }
    return this.cls.run(async () => {
      this.cls.set('organizationId', organizationId);
      this.cls.set('userId', userId);
      const tenantUser = await this.tenantUserModel()
        .query()
        .findOne('systemUserId', userId)
        .withGraphFetched('role.permissions');
      if (!tenantUser?.role) return false;
      const ability = getAbilityForRole(tenantUser.role);
      cacheAbility(organizationId, userId, ability);
      return ability.can(
        CryptoExchangeAction.View,
        AbilitySubject.CryptoExchange,
      );
    });
  }
}
