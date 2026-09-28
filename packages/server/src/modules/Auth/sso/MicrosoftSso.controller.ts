import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import {
  MicrosoftSsoService,
  MicrosoftSsoSignInError,
} from './MicrosoftSso.service';
import { MicrosoftSsoExchangeDto } from './dtos/MicrosoftSsoExchange.dto';
import { PublicRoute } from '../guards/jwt.guard';
import { AuthSigninService } from '../commands/AuthSignin.service';
import { AuthSigninResponseDto } from '../dtos/AuthSigninResponse.dto';
import { SystemUser } from '@/modules/System/models/SystemUser';
import { TenantAgnosticRoute } from '@/modules/Tenancy/TenancyGlobal.guard';

@Controller('/auth/sso/microsoft')
@ApiTags('Auth')
@PublicRoute()
@TenantAgnosticRoute()
@Throttle({ auth: {} })
export class MicrosoftSsoController {
  constructor(
    private readonly microsoftSso: MicrosoftSsoService,
    private readonly authSignin: AuthSigninService,
    private readonly config: ConfigService,

    @Inject(SystemUser.name)
    private readonly systemUserModel: typeof SystemUser,
  ) {}

  /** The webapp's login page sends the browser here to start Microsoft sign-in. */
  @Get('/start')
  @ApiOperation({ summary: 'Start "Sign in with Microsoft"' })
  async start(@Res() res: Response) {
    try {
      const url = await this.microsoftSso.buildAuthorizationUrl();
      return res.redirect(302, url);
    } catch (error) {
      return res.redirect(302, this.loginUrl(this.rejectionReason(error)));
    }
  }

  /** Microsoft redirects the browser back here after the person signs in. */
  @Get('/callback')
  @ApiOperation({ summary: 'Handle the redirect back from Microsoft' })
  async callback(
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    if (error || !code || !state) {
      return res.redirect(302, this.loginUrl('cancelled'));
    }
    try {
      const exchangeCode = await this.microsoftSso.handleCallback(
        code,
        state,
        async (email) =>
          (await this.systemUserModel
            .query()
            .whereRaw('LOWER(email) = ?', [email.toLowerCase()])
            .first()) ?? null,
        async (user, oid) => {
          await this.systemUserModel
            .query()
            .findById(user.id)
            .patch({
              microsoftOid: oid,
              ssoProvider: 'microsoft',
            } as Partial<SystemUser>);
        },
      );
      const base =
        this.config.get<string>('app.baseUrl')?.replace(/\/$/, '') ?? '';
      return res.redirect(
        302,
        `${base}/auth/sso/callback?code=${encodeURIComponent(exchangeCode)}`,
      );
    } catch (err) {
      return res.redirect(302, this.loginUrl(this.rejectionReason(err)));
    }
  }

  /** The webapp exchanges the one-time code from the callback for real tokens. */
  @Post('/exchange')
  @ApiOperation({ summary: 'Exchange a Microsoft sign-in code for tokens' })
  async exchange(
    @Body() { code }: MicrosoftSsoExchangeDto,
  ): Promise<AuthSigninResponseDto> {
    const invalid = () =>
      new UnauthorizedException({
        errors: [
          {
            type: 'SSO_CODE_INVALID',
            message: 'That sign-in attempt has expired. Try again.',
          },
        ],
      });

    const userId = await this.microsoftSso.resolveExchangeCode(code);
    if (!userId) throw invalid();

    const user = await this.authSignin.findById(userId);
    if (!user) throw invalid();

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

  private rejectionReason(error: unknown): string {
    return error instanceof MicrosoftSsoSignInError ? error.reason : 'failed';
  }

  private loginUrl(reason: string): string {
    const base =
      this.config.get<string>('app.baseUrl')?.replace(/\/$/, '') ?? '';
    return `${base}/auth/login?ssoError=${encodeURIComponent(reason)}`;
  }
}
