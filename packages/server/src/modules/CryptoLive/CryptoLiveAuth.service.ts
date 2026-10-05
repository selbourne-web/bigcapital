import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { SystemUser } from '../System/models/SystemUser';
import { TenantModel } from '../System/models/TenantModel';
import { UserTenant } from '../System/models/UserTenant.model';
import { JWT_AUDIENCE, JWT_ISSUER } from '../Auth/Auth.constants';

/** Rejection category. Logged and tested; the client only ever sees "unauthorized". */
export type CryptoLiveRejection =
  | 'bad-handshake'
  | 'origin'
  | 'invalid-token'
  | 'token-expired'
  | 'user-not-found'
  | 'organization-not-found'
  | 'not-member'
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
  /** Token expiry, epoch milliseconds. */
  expiresAt: number;
}

/**
 * Authenticates a socket handshake exactly as the REST layer authenticates a request:
 * the JWT is verified like `JwtStrategy` (HS384, same secret, issuer and audience), the
 * user must exist like `AuthSigninService.verifyPayload`, and the user must be a member
 * of the requested organization like `TenancyGlobalGuard` (tenant by `organizationId`,
 * then a `user_tenants` row for `{ userId, tenantId }`).
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

    return { userId, tenantId: tenant.id, expiresAt: payload.exp * 1000 };
  }
}
