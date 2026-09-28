import { ClsService } from 'nestjs-cls';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { SystemUser } from '@/modules/System/models/SystemUser';
import { TenantModel } from '@/modules/System/models/TenantModel';
import { UserTenant } from '@/modules/System/models/UserTenant.model';
import { ModelObject } from 'objection';
import { JwtPayload } from '../Auth.interfaces';
import { JWT_ISSUER, JWT_AUDIENCE } from '../Auth.constants';
import { InvalidEmailPasswordException } from '../exceptions/InvalidEmailPassword.exception';
import { PasswordSigninRequiresMfaException } from '../exceptions/PasswordSigninRequiresMfa.exception';
import { UserNotFoundException } from '../exceptions/UserNotFound.exception';

@Injectable()
export class AuthSigninService {
  constructor(
    @Inject(SystemUser.name)
    private readonly systemUserModel: typeof SystemUser,

    @Inject(TenantModel.name)
    private readonly tenantModel: typeof TenantModel,

    @Inject(UserTenant.name)
    private readonly userTenantModel: typeof UserTenant,

    private readonly jwtService: JwtService,
    private readonly clsService: ClsService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Validates the given email and password.
   * @param {string} email - Signin email address.
   * @param {string} password - Signin password.
   * @returns {Promise<ModelObject<SystemUser>>}
   */
  async signin(
    email: string,
    password: string,
  ): Promise<ModelObject<SystemUser>> {
    let user: SystemUser;

    try {
      user = await this.systemUserModel
        .query()
        .findOne({ email })
        .throwIfNotFound();
    } catch (_err) {
      throw new InvalidEmailPasswordException(email);
    }
    if (!(await user.checkPassword(password))) {
      throw new InvalidEmailPasswordException(email);
    }
    // Once required, password sign-in only completes for accounts that
    // already have two-factor authentication set up; see mfa.requireForPassword.
    if (
      this.configService.get<boolean>('mfa.requireForPassword') &&
      !user.mfaEnabled
    ) {
      throw new PasswordSigninRequiresMfaException();
    }
    return user;
  }

  /**
   * Finds a system user by id, or null. Used to resolve a two-factor
   * sign-in challenge back to the account it was issued for.
   */
  async findById(userId: number): Promise<SystemUser | null> {
    return (await this.systemUserModel.query().findById(userId)) ?? null;
  }

  /**
   * Verifies the given jwt payload.
   * @param {JwtPayload} payload
   * @returns {Promise<any>}
   */
  async verifyPayload(payload: JwtPayload): Promise<any> {
    if (payload.iss !== JWT_ISSUER || payload.aud !== JWT_AUDIENCE) {
      throw new UnauthorizedException('Invalid token claims.');
    }
    let user: SystemUser;
    try {
      user = await this.systemUserModel
        .query()
        .findOne({ id: Number(payload.sub) })
        .throwIfNotFound();

      this.clsService.set('userId', user.id);
    } catch (_error) {
      throw new UserNotFoundException(String(payload.sub));
    }
    return payload;
  }

  /**
   * Resolves which tenant a user should sign in to:
   *  1. Their explicit default workspace (`defaultTenantId`).
   *  2. Their initial/legacy workspace (`tenantId`).
   *  3. The first active workspace they have a membership in.
   * Returns null when the user has no active workspace available.
   */
  async resolveSigninTenant(user: SystemUser): Promise<TenantModel | null> {
    if (user.defaultTenantId) {
      const tenant = await this.tryGetActiveTenantForUser(
        user.id,
        user.defaultTenantId,
      );
      if (tenant) return tenant;
    }
    if (user.tenantId) {
      const tenant = await this.tryGetActiveTenantForUser(
        user.id,
        user.tenantId,
      );
      if (tenant) return tenant;
    }
    const memberships = await this.userTenantModel
      .query()
      .where('userId', user.id)
      .withGraphFetched('tenant')
      .orderBy('id', 'asc');

    const active = memberships.find((m) => m.tenant?.isActive);
    return active?.tenant ?? null;
  }

  /**
   * Returns the tenant only when the user is a member and the tenant is active.
   */
  private async tryGetActiveTenantForUser(
    userId: number,
    tenantId: number,
  ): Promise<TenantModel | null> {
    const membership = await this.userTenantModel
      .query()
      .where({ userId, tenantId })
      .withGraphFetched('tenant')
      .first();

    if (!membership?.tenant?.isActive) return null;
    return membership.tenant;
  }

  /**
   *
   * @param {SystemUser} user
   * @param {boolean} rememberMe - Extends the token lifetime when the user opted to stay signed in.
   * @returns {string}
   */
  signToken(user: SystemUser, rememberMe = false): string {
    const payload = {
      sub: String(user.id),
    };
    const expiresIn = rememberMe ? '30d' : '1d';
    return this.jwtService.sign(payload, {
      expiresIn,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
  }
}
