import { Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PaymentLink } from '../PaymentLinks/models/PaymentLink';
import { assertPaymentLinkAccessible } from '../PaymentLinks/payment-link.utils';
import { TenantModel } from '../System/models/TenantModel';
import { GetSaleEstimatePdf } from '../SaleEstimates/queries/GetSaleEstimatePdf';
import { GetCreditNotePdf } from '../CreditNotes/queries/GetCreditNotePdf.serivce';
import { ViewableDocumentType } from '../DocumentLinks/DocumentViewLinks.service';

/** What the public page needs to show a document. */
export interface DocumentViewMeta {
  documentType: 'estimate' | 'credit-note';
  title: string;
  number: string;
  date?: string;
  /** Estimate expiration date. */
  expirationDate?: string;
  total?: string;
  companyName?: string;
  primaryColor?: string;
  /** The document exactly as it prints, as a complete html page. */
  html: string;
}

/**
 * Public read access to estimates and credit notes through their view link.
 * Follows the invoice payment link: the link id is looked up across tenants and
 * the request then switches to the tenant that owns it.
 */
@Injectable()
export class GetDocumentView {
  constructor(
    private readonly clsService: ClsService,
    private readonly estimatePdf: GetSaleEstimatePdf,
    private readonly creditNotePdf: GetCreditNotePdf,

    @Inject(PaymentLink.name)
    private readonly paymentLinkModel: typeof PaymentLink,

    @Inject(TenantModel.name)
    private readonly systemTenantModel: typeof TenantModel,
  ) {}

  /**
   * Finds the link and switches the request to the tenant that owns it.
   * @param {string} linkId
   * @param {ViewableDocumentType} resourceType
   */
  private async resolveLink(
    linkId: string,
    resourceType: ViewableDocumentType,
  ): Promise<PaymentLink> {
    const paymentLink = await this.paymentLinkModel
      .query()
      .findOne('linkId', linkId)
      .where('resourceType', resourceType)
      .throwIfNotFound();

    const callerOrganizationId = this.clsService.get<string>('organizationId');
    const tenant = await this.systemTenantModel
      .query()
      .findById(paymentLink.tenantId);

    assertPaymentLinkAccessible(
      paymentLink,
      tenant.organizationId,
      callerOrganizationId,
    );
    this.clsService.set('organizationId', tenant.organizationId);

    return paymentLink;
  }

  public async getEstimateView(linkId: string): Promise<DocumentViewMeta> {
    const link = await this.resolveLink(linkId, 'SaleEstimate');
    const attributes: Record<string, any> =
      await this.estimatePdf.getEstimateBrandingAttributes(link.resourceId);

    return {
      documentType: 'estimate',
      title: 'Estimate',
      number: attributes.estimateNumebr,
      date: attributes.estimateDate,
      expirationDate: attributes.expirationDate,
      total: attributes.total,
      companyName: attributes.companyName,
      primaryColor: attributes.primaryColor,
      html: await this.estimatePdf.saleEstimateHtml(link.resourceId),
    };
  }

  public async getEstimatePdf(linkId: string): Promise<[Buffer, string]> {
    const link = await this.resolveLink(linkId, 'SaleEstimate');

    return this.estimatePdf.getSaleEstimatePdf(link.resourceId);
  }

  public async getCreditNoteView(linkId: string): Promise<DocumentViewMeta> {
    const link = await this.resolveLink(linkId, 'CreditNote');
    const attributes: Record<string, any> =
      await this.creditNotePdf.getCreditNoteBrandingAttributes(link.resourceId);

    return {
      documentType: 'credit-note',
      title: 'Credit Note',
      number: attributes.creditNoteNumebr,
      date: attributes.creditNoteDate,
      total: attributes.total,
      companyName: attributes.companyName,
      primaryColor: attributes.primaryColor,
      html: await this.creditNotePdf.getCreditNoteHtml(link.resourceId),
    };
  }

  public async getCreditNotePdf(linkId: string): Promise<[Buffer, string]> {
    const link = await this.resolveLink(linkId, 'CreditNote');

    return this.creditNotePdf.getCreditNotePdf(link.resourceId);
  }
}
