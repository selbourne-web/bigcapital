import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class MicrosoftSsoExchangeDto {
  @ApiProperty({
    description: 'The one-time code from /auth/sso/callback?code=...',
  })
  @IsNotEmpty()
  @IsString()
  code: string;
}
