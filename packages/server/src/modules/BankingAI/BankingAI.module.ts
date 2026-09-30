import { Module } from '@nestjs/common';
import { BankingAIController } from './BankingAI.controller';
import { TransactionClassificationService } from './TransactionClassification.service';
import { TenancyModule } from '../Tenancy/Tenancy.module';
import { BankingTransactionsModule } from '../BankingTransactions/BankingTransactions.module';

/**
 * Proposes categories for uncategorized bank transactions with the Claude
 * API. Stateless: nothing is stored here, the webapp shows the proposal and
 * the bookkeeper reviews it before categorizing.
 */
@Module({
  imports: [TenancyModule, BankingTransactionsModule],
  providers: [TransactionClassificationService],
  controllers: [BankingAIController],
})
export class BankingAIModule {}
