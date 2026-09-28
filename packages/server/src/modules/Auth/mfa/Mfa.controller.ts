import { Body, Controller, Post, UnauthorizedException } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { MfaService } from './Mfa.service';
import { MfaEnableDto } from './dtos/MfaEnable.dto';
import { MfaVerifyLoginDto } from './dtos/MfaVerifyLogin.dto';
import { PublicRoute } from '../guards/jwt.guard';
import { AuthSigninService } from '../commands/AuthSignin.service';
import { AuthSigninResponseDto } from '../dtos/AuthSigninResponse.dto';
import { TenancyContext } from '@/modules/Tenancy/TenancyContext.service';
import { TenantAgnosticRoute } from '@/modules/Tenancy/TenancyGlobal.guard';

@Controller('/auth/mfa')
@ApiTags('Auth')
@TenantAgnosticRoute()
@Throttle({ auth: {} })
export class MfaController {
  constructor(
    private readonly mfaService: MfaService,
    private readonly tenancyContext: TenancyContext,
    private readonly authSignin: AuthSigninService,
  ) {}

  /**
   * Starts two-factor setup for the signed-in account: a fresh secret, not
   * yet active until {@link enable} proves it.
   */
  @Post('/setup')
  @ApiOperation({ summary: 'Start two-factor authentication setup' })
  async setup() {
    const user = await this.tenancyContext.getSystemUser();
    return this.mfaService.startEnrollment(user.id, user.email);
  }

  /**
   * Confirms setup with a code from the authenticator app; turns two-factor
   * authentication on and returns one-time recovery codes.
   */
  @Post('/enable')
  @ApiOperation({ summary: 'Confirm and enable two-factor authentication' })
  @ApiBody({ type: MfaEnableDto })
  async enable(@Body() { token }: MfaEnableDto) {
    const user = await this.tenancyContext.getSystemUser();
    return this.mfaService.enable(user.id, token);
  }

  /**
   * Turns two-factor authentication off. Requires a currently valid code, so
   * a stolen session token alone cannot disable it.
   */
  @Post('/disable')
  @ApiOperation({ summary: 'Disable two-factor authentication' })
  @ApiBody({ type: MfaEnableDto })
  async disable(@Body() { token }: MfaEnableDto) {
    const user = await this.tenancyContext.getSystemUser();

    if (!(await this.mfaService.verifyToken(user, token))) {
      throw new UnauthorizedException({
        errors: [
          { type: 'MFA_INVALID_CODE', message: 'That code is not correct.' },
        ],
      });
    }
    await this.mfaService.disable(user.id);
    return { message: 'Two-factor authentication has been turned off.' };
  }

  /**
   * Finishes a password sign-in that was held for two-factor authentication
   * (see POST /auth/signin), with either an authenticator code or a
   * recovery code.
   */
  @Post('/verify-login')
  @PublicRoute()
  @ApiOperation({ summary: 'Finish a two-factor sign-in challenge' })
  @ApiBody({ type: MfaVerifyLoginDto })
  async verifyLogin(
    @Body() { challengeToken, token, recoveryCode }: MfaVerifyLoginDto,
  ): Promise<AuthSigninResponseDto> {
    const invalidChallenge = () =>
      new UnauthorizedException({
        errors: [
          {
            type: 'MFA_CHALLENGE_EXPIRED',
            message: 'That sign-in attempt has expired. Sign in again.',
          },
        ],
      });

    const userId = await this.mfaService.resolveLoginChallenge(challengeToken);
    if (!userId) throw invalidChallenge();

    const user = await this.authSignin.findById(userId);
    if (!user) throw invalidChallenge();

    const verified = token
      ? await this.mfaService.verifyToken(user, token)
      : recoveryCode
        ? await this.mfaService.verifyAndConsumeRecoveryCode(user, recoveryCode)
        : false;

    if (!verified) {
      throw new UnauthorizedException({
        errors: [
          { type: 'MFA_INVALID_CODE', message: 'That code is not correct.' },
        ],
      });
    }

    const tenant = await this.authSignin.resolveSigninTenant(user);
    if (!tenant) {
      throw new UnauthorizedException({
        message:
          'No active workspace available. Please contact the administrator.',
        errors: [{ type: 'ORGANIZATION.INACTIVE' }],
      });
    }
    return {
      accessToken: this.authSignin.signToken(user),
      organizationId: tenant.organizationId,
      tenantId: tenant.id,
      userId: user.id,
    };
  }
}
