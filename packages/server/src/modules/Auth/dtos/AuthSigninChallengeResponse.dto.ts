import { ApiProperty } from '@nestjs/swagger';

/** Returned instead of tokens when the account has two-factor authentication
 * turned on: POST the challenge token and a code to /auth/mfa/verify-login. */
export class AuthSigninChallengeResponseDto {
  @ApiProperty({ example: true })
  mfaRequired: true;

  @ApiProperty({ description: 'Pass this to POST /auth/mfa/verify-login' })
  challengeToken: string;
}
