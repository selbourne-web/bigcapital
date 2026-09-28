import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class MfaVerifyLoginDto {
  @ApiProperty({ description: 'The challenge id returned by /auth/signin' })
  @IsNotEmpty()
  @IsString()
  challengeToken: string;

  @ApiProperty({
    example: '123456',
    description: 'The current 6-digit code from the authenticator app',
    required: false,
  })
  @IsOptional()
  @IsString()
  token?: string;

  @ApiProperty({
    example: 'ABCD-1234',
    description: 'A one-time recovery code, instead of an authenticator code',
    required: false,
  })
  @IsOptional()
  @IsString()
  recoveryCode?: string;
}
