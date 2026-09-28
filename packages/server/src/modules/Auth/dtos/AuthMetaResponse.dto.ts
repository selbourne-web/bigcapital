import { ApiProperty } from '@nestjs/swagger';

export class AuthMetaResponseDto {
  @ApiProperty({ description: 'Whether signup is disabled' })
  signupDisabled: boolean;

  @ApiProperty({ description: 'Whether "Sign in with Microsoft" is offered' })
  microsoftSsoEnabled: boolean;
}
