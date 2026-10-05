import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { parseBoolean } from '@/utils/parse-boolean';

export class DeleteCryptoConnectionQueryDto {
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => parseBoolean(value, false))
  @ApiProperty({
    required: false,
    default: false,
    description:
      'true also deletes the stored raw records, balance snapshots and sync runs; by default they are kept.',
  })
  deleteData?: boolean;
}
