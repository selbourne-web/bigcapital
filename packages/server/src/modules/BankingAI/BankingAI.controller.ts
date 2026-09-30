import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Inject,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiCommonHeaders } from '@/common/decorators/ApiCommonHeaders';
import { TenancyContext } from '../Tenancy/TenancyContext.service';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { Account } from '@/modules/Accounts/models/Account.model';
import { UncategorizedBankTransaction } from '@/modules/BankingTransactions/models/UncategorizedBankTransaction';
import { TransactionClassificationService } from './TransactionClassification.service';
import { ClassifyBankTransactionDto } from './dtos/ClassifyBankTransaction.dto';
import { ClassificationAccountOption } from './TransactionClassification.schema';

const failure = (type: string, message: string) => ({
  errors: [{ type, message }],
});

// Each classification costs money, so a person may classify a reasonable
// number of transactions a minute, not hundreds. In memory: it resets on
// restart, which is fine for a spending guard.
const RATE_LIMIT_PER_MINUTE = 20;
const attempts = new Map<number, number[]>();

const assertWithinRateLimit = (userId: number) => {
  const now = Date.now();
  const recent = (attempts.get(userId) ?? []).filter(
    (time) => now - time < 60_000,
  );
  if (recent.length >= RATE_LIMIT_PER_MINUTE) {
    throw new HttpException(
      failure(
        'CLASSIFY_BUSY',
        'Too many AI categorizations in a short time. Please wait a minute and try again.',
      ),
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
  attempts.set(userId, [...recent, now]);
};

@Controller('banking-ai')
@ApiTags('Banking AI')
@ApiCommonHeaders()
export class BankingAIController {
  constructor(
    private readonly classification: TransactionClassificationService,
    private readonly tenancyContext: TenancyContext,

    @Inject(UncategorizedBankTransaction.name)
    private readonly uncategorizedBankTransactionModel: TenantModelProxy<
      typeof UncategorizedBankTransaction
    >,
    @Inject(Account.name)
    private readonly accountModel: TenantModelProxy<typeof Account>,
  ) {}

  @Post('classify')
  @ApiOperation({
    summary: 'Propose a category for an uncategorized bank transaction',
    description:
      'Sends the transaction (description, amount, date) and the chart of accounts to the Claude API and returns a proposed account with a confidence score and reasoning. Nothing is saved or posted; the bookkeeper reviews the proposal before categorizing.',
  })
  @ApiResponse({ status: 200, description: 'The proposed classification' })
  @ApiResponse({
    status: 503,
    description: 'AI categorization is not configured',
  })
  public async classify(@Body() classifyDto: ClassifyBankTransactionDto) {
    if (!this.classification.isConfigured()) {
      throw new HttpException(
        failure(
          'CLASSIFY_NOT_CONFIGURED',
          'AI categorization is not set up. An administrator needs to add an Anthropic API key to the server settings.',
        ),
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const user = await this.tenancyContext.getSystemUser();
    assertWithinRateLimit(user.id);

    const transaction = await this.uncategorizedBankTransactionModel()
      .query()
      .whereIn('id', classifyDto.uncategorizedTransactionIds)
      .first()
      .throwIfNotFound();

    const accountModels = await this.accountModel()
      .query()
      .where('active', true);

    const accounts: ClassificationAccountOption[] = accountModels
      .filter(
        (account) =>
          account.accountRootType === 'expense' ||
          account.accountRootType === 'income',
      )
      .map((account) => ({
        id: account.id,
        name: account.name,
        type: account.accountRootType as 'expense' | 'income',
      }));

    const result = await this.classification.classify(
      {
        date:
          typeof transaction.date === 'string'
            ? transaction.date
            : transaction.date.toISOString(),
        amount: transaction.amount,
        isDeposit: transaction.isDepositTransaction,
        currencyCode: transaction.currencyCode,
        description: transaction.description ?? null,
        payee: transaction.payee ?? null,
      },
      accounts,
    );
    return { data: result };
  }
}
