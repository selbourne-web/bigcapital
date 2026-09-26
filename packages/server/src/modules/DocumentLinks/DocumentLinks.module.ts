import { Module } from '@nestjs/common';
import { DocumentViewLinks } from './DocumentViewLinks.service';
import { InjectSystemModel } from '../System/SystemModels/SystemModels.module';
import { PaymentLink } from '../PaymentLinks/models/PaymentLink';
import { TenancyModule } from '../Tenancy/Tenancy.module';

const models = [InjectSystemModel(PaymentLink)];

/**
 * Creates the public view links of estimates and credit notes. Kept apart from
 * PaymentLinksModule (which reads them and needs those documents' PDF services)
 * so the document modules can use it without a circular import.
 */
@Module({
  imports: [TenancyModule],
  providers: [...models, DocumentViewLinks],
  exports: [DocumentViewLinks],
})
export class DocumentLinksModule {}
