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
import { ToNumber } from '@/common/decorators/Validators';
import {
  CSV_ONLY_EXCHANGES,
  CsvOnlyExchangeId,
} from '../CryptoExchanges.constants';
import { trimString } from './CreateCryptoConnection.dto';

/** Column width of `crypto_connections.label`. */
export const CSV_ONLY_LABEL_MAX = 255;

/**
 * Body of `POST /crypto/connections/csv-only`: a connection fed only by CSV
 * imports. No credential fields exist (the app's pipe strips unknown fields).
 */
export class CreateCsvOnlyConnectionDto {
  @IsIn(CSV_ONLY_EXCHANGES as unknown as string[])
  @ApiProperty({ enum: CSV_ONLY_EXCHANGES, example: 'nexo' })
  exchange: CsvOnlyExchangeId;

  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(CSV_ONLY_LABEL_MAX)
  @ApiProperty({ example: 'Nexo', maxLength: CSV_ONLY_LABEL_MAX })
  label: string;

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
}
