import { IsNotEmpty, IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class MfaEnableDto {
  @ApiProperty({
    example: '123456',
    description: 'The current 6-digit code from the authenticator app',
  })
  @IsNotEmpty()
  @IsString()
  @Length(6, 6)
  token: string;
}
