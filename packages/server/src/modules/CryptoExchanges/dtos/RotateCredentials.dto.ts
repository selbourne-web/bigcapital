import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  CRYPTO_CREDENTIAL_MAX,
  trimString,
} from './CreateCryptoConnection.dto';

export class RotateCredentialsDto {
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(CRYPTO_CREDENTIAL_MAX)
  @ApiProperty({ description: 'New read-only API key' })
  apiKey: string;

  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(CRYPTO_CREDENTIAL_MAX)
  @ApiProperty({ description: 'New API secret' })
  apiSecret: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(CRYPTO_CREDENTIAL_MAX)
  @ApiProperty({ required: false })
  passphrase?: string;

  @IsOptional()
  @IsBoolean()
  @ApiProperty({ required: false })
  attestReadOnly?: boolean;
}
