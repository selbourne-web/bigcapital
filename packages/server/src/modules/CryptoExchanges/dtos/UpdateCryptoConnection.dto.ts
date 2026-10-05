import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { CRYPTO_USER_SETTABLE_STATUSES } from '../CryptoExchanges.constants';
import { ToNumber } from '@/common/decorators/Validators';
import { CRYPTO_LABEL_MAX, trimString } from './CreateCryptoConnection.dto';

export class UpdateCryptoConnectionDto {
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(CRYPTO_LABEL_MAX)
  @ApiProperty({ required: false, maxLength: CRYPTO_LABEL_MAX })
  label?: string;

  /** `paused` pauses syncing, `active` resumes it. `error` is system-set only. */
  @IsOptional()
  @IsIn(CRYPTO_USER_SETTABLE_STATUSES as unknown as string[])
  @ApiProperty({ required: false, enum: CRYPTO_USER_SETTABLE_STATUSES })
  status?: 'active' | 'paused';

  /** An asset account id, or `null` to unmap. */
  @IsOptional()
  @ToNumber()
  @IsInt()
  @ApiProperty({ required: false, nullable: true })
  accountId?: number | null;
}
