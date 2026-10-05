import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { SUPPORTED_CRYPTO_EXCHANGES } from '../CryptoExchanges.constants';
import { ToNumber } from '@/common/decorators/Validators';

export const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export const CRYPTO_LABEL_MAX = 100;
export const CRYPTO_CREDENTIAL_MAX = 512;

export class CreateCryptoConnectionDto {
  @IsIn(SUPPORTED_CRYPTO_EXCHANGES as unknown as string[])
  @ApiProperty({ enum: SUPPORTED_CRYPTO_EXCHANGES, example: 'kraken' })
  exchange: string;

  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(CRYPTO_LABEL_MAX)
  @ApiProperty({ example: 'Kraken - Trading', maxLength: CRYPTO_LABEL_MAX })
  label: string;

  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(CRYPTO_CREDENTIAL_MAX)
  @ApiProperty({ description: 'Read-only API key' })
  apiKey: string;

  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(CRYPTO_CREDENTIAL_MAX)
  @ApiProperty({ description: 'API secret' })
  apiSecret: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(CRYPTO_CREDENTIAL_MAX)
  @ApiProperty({ required: false })
  passphrase?: string;

  /** Existing asset account to map; mutually exclusive with `createAccount: true`. */
  @IsOptional()
  @ToNumber()
  @IsInt()
  @ApiProperty({ required: false })
  accountId?: number;

  @IsOptional()
  @IsBoolean()
  @ValidateIf((o) => o.accountId != null)
  @Equals(false, {
    message: 'accountId and createAccount are mutually exclusive',
  })
  @ApiProperty({ required: false })
  createAccount?: boolean;

  /** The user attests the key is read-only when the exchange cannot tell us. */
  @IsOptional()
  @IsBoolean()
  @ApiProperty({ required: false })
  attestReadOnly?: boolean;
}
