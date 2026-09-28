import { UnauthorizedException } from '@nestjs/common';
import { ERRORS } from '../Auth.constants';

/**
 * Thrown when password sign-in is only allowed for accounts that already
 * have two-factor authentication set up (see `mfa.requireForPassword`), and
 * this one does not yet.
 */
export class PasswordSigninRequiresMfaException extends UnauthorizedException {
  constructor() {
    super({
      statusCode: 401,
      error: 'Unauthorized',
      message:
        'Password sign-in requires two-factor authentication for this account. Ask an administrator to set it up, or sign in with Microsoft.',
      code: ERRORS.PASSWORD_SIGNIN_REQUIRES_MFA,
    });
  }
}
