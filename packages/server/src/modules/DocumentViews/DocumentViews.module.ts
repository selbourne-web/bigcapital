import { Module } from '@nestjs/common';
import { GetDocumentView } from './GetDocumentView.service';
import { DocumentViewsController } from './DocumentViews.controller';
import { InjectSystemModel } from '../System/SystemModels/SystemModels.module';
import { PaymentLink } from '../PaymentLinks/models/PaymentLink';
import { TenancyModule } from '../Tenancy/Tenancy.module';
import { SaleEstimatesModule } from '../SaleEstimates/SaleEstimates.module';
import { CreditNotesModule } from '../CreditNotes/CreditNotes.module';

const models = [InjectSystemModel(PaymentLink)];

/**
 * The public pages customers open from the link in an estimate or credit note
 * email. A module of its own that nothing else imports: it needs the PDF
 * services of both documents, and importing it from the payment links module
 * would close an import cycle through the invoices module.
 */
@Module({
  imports: [TenancyModule, SaleEstimatesModule, CreditNotesModule],
  providers: [...models, GetDocumentView],
  controllers: [DocumentViewsController],
})
export class DocumentViewsModule {}
