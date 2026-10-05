import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';
import { ToNumber } from '@/common/decorators/Validators';

export class GetCryptoSyncRunsQueryDto {
  @IsOptional()
  @ToNumber()
  @IsInt()
  @ApiProperty({ required: false, description: 'Only runs of this connection' })
  connectionId?: number;

  @IsOptional()
  @ToNumber()
  @IsInt()
  @Min(1)
  @ApiProperty({
    required: false,
    default: 20,
    maximum: 100,
    description: 'Number of runs to return, newest first (capped at 100)',
  })
  limit?: number;
}
