import { Module } from '@nestjs/common';
import { ExpenseAutofillController } from './ExpenseAutofill.controller';
import { ReceiptExtractionService } from './ReceiptExtraction.service';
import { TenancyModule } from '../Tenancy/Tenancy.module';

/**
 * Reads a receipt or bill with the Claude API and returns values for the
 * expense form. Stateless: nothing is stored here, the webapp fills the form
 * and the person reviews it before saving.
 */
@Module({
  imports: [TenancyModule],
  providers: [ReceiptExtractionService],
  controllers: [ExpenseAutofillController],
})
export class ExpenseAutofillModule {}
