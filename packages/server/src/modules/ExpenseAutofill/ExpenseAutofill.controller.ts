import { memoryStorage } from 'multer';
import {
  BadRequestException,
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Post,
  ServiceUnavailableException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiCommonHeaders } from '@/common/decorators/ApiCommonHeaders';
import { TenancyContext } from '../Tenancy/TenancyContext.service';
import { ReceiptExtractionService } from './ReceiptExtraction.service';
import type { ExpenseAccountOption } from './ReceiptExtraction.schema';
import { MAX_RECEIPT_BYTES, sniffReceiptMediaType } from './receipt-file.utils';

const failure = (type: string, message: string) => ({
  errors: [{ type, message }],
});

/** The expense accounts the webapp offers for a line (parsed from a form field). */
const accountsSchema = z
  .array(
    z.object({
      id: z.number().int().positive(),
      name: z.string().max(200),
    }),
  )
  .max(300);

// Each reading costs money, so a person may read a few receipts a minute, not
// hundreds. In memory: it resets on restart, which is fine for a spending guard.
const RATE_LIMIT_PER_MINUTE = 10;
const attempts = new Map<number, number[]>();

const assertWithinRateLimit = (userId: number) => {
  const now = Date.now();
  const recent = (attempts.get(userId) ?? []).filter(
    (time) => now - time < 60_000,
  );
  if (recent.length >= RATE_LIMIT_PER_MINUTE) {
    throw new HttpException(
      failure(
        'AUTOFILL_BUSY',
        'Too many receipts in a short time. Please wait a minute and try again.',
      ),
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
  attempts.set(userId, [...recent, now]);
};

@Controller('expense-autofill')
@ApiTags('Expense Autofill')
@ApiCommonHeaders()
export class ExpenseAutofillController {
  constructor(
    private readonly extraction: ReceiptExtractionService,
    private readonly tenancyContext: TenancyContext,
  ) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_RECEIPT_BYTES, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Read a receipt or bill to fill in the expense form',
    description:
      'Sends the receipt (PDF, PNG, JPEG, GIF or WebP, up to 10 MB) to the Claude API and returns the payee, date, reference, currency and line items. Nothing is saved.',
  })
  @ApiResponse({ status: 200, description: 'The values read from the receipt' })
  @ApiResponse({ status: 503, description: 'Autofill is not configured' })
  public async autofill(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('accounts') accountsField?: string,
  ) {
    if (!this.extraction.isConfigured()) {
      throw new ServiceUnavailableException(
        failure(
          'AUTOFILL_NOT_CONFIGURED',
          'Receipt autofill is not set up. An administrator needs to add an Anthropic API key to the server settings.',
        ),
      );
    }
    if (!file?.buffer?.length) {
      throw new BadRequestException(
        failure('AUTOFILL_NO_FILE', 'Choose a receipt or bill to read.'),
      );
    }
    // Judged by the file's own bytes, not by its name or the claimed type.
    const mediaType = sniffReceiptMediaType(file.buffer);
    if (!mediaType) {
      throw new BadRequestException(
        failure(
          'AUTOFILL_UNSUPPORTED_FILE',
          'Use a PDF, PNG or JPEG. Photos in HEIC format need to be saved as JPEG first.',
        ),
      );
    }
    let accounts: ExpenseAccountOption[] = [];
    if (accountsField) {
      try {
        accounts = accountsSchema.parse(
          JSON.parse(accountsField),
        ) as ExpenseAccountOption[];
      } catch {
        throw new BadRequestException(
          failure('AUTOFILL_BAD_ACCOUNTS', 'The account list was not valid.'),
        );
      }
    }
    const user = await this.tenancyContext.getSystemUser();
    assertWithinRateLimit(user.id);

    return {
      data: await this.extraction.extract(file.buffer, mediaType, accounts),
    };
  }
}
