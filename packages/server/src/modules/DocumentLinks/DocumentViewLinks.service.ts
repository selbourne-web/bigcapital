import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';
import { PaymentLink } from '../PaymentLinks/models/PaymentLink';
import { TenancyContext } from '../Tenancy/TenancyContext.service';

/** Documents a customer can open online from the link in an email. */
export type ViewableDocumentType = 'SaleEstimate' | 'CreditNote';

/** The public page path of each document type: `{BASE_URL}/view/{path}/{linkId}`. */
export const VIEW_PATH: Record<ViewableDocumentType, string> = {
  SaleEstimate: 'estimate',
  CreditNote: 'credit-note',
};

@Injectable()
export class DocumentViewLinks {
  constructor(
    private readonly tenancyContext: TenancyContext,
    private readonly configService: ConfigService,

    @Inject(PaymentLink.name)
    private readonly paymentLinkModel: typeof PaymentLink,
  ) {}

  /**
   * The public link a customer follows to view the given document. A document
   * keeps one link, so a resend does not invalidate the link in an earlier email.
   * @param {ViewableDocumentType} resourceType
   * @param {number} resourceId
   * @returns {Promise<string>} The absolute url of the public page.
   */
  public async getOrCreateLink(
    resourceType: ViewableDocumentType,
    resourceId: number,
  ): Promise<string> {
    const tenant = await this.tenancyContext.getTenant();

    const existing = await this.paymentLinkModel.query().findOne({
      tenantId: tenant.id,
      resourceType,
      resourceId,
      publicity: 'public',
    });
    const link =
      existing ??
      (await this.paymentLinkModel.query().insert({
        linkId: uuidv4(),
        publicity: 'public',
        resourceType,
        resourceId,
        tenantId: tenant.id,
      }));
    const baseUrl = this.configService.get('app.baseUrl');

    return `${baseUrl}/view/${VIEW_PATH[resourceType]}/${link.linkId}`;
  }
}
