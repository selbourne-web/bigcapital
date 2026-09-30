import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ClassifyBankTransactionDto {
  @ApiProperty({
    description: 'Uncategorized bank transaction ids to classify together',
    type: [Number],
    example: [1001],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsInt({ each: true })
  uncategorizedTransactionIds: number[];
}
