import { pickBy } from 'lodash';
import { InvoicePdfTemplateAttributes } from './SaleInvoice.types';
import { SaleInvoiceResponseDto } from './dtos/SaleInvoiceResponse.dto';
import { contactAddressTextFormat } from '@/utils/address-text-format';

export const mergePdfTemplateWithDefaultAttributes = (
  brandingTemplate?: Record<string, any>,
  defaultAttributes: Record<string, any> = {},
) => {
  const brandingAttributes = pickBy(
    brandingTemplate,
    (val, key) => val !== null && Object.keys(defaultAttributes).includes(key),
  );
  return {
    ...defaultAttributes,
    ...brandingAttributes,
  };
};

export const transformInvoiceToPdfTemplate = (
  invoice: SaleInvoiceResponseDto,
): Partial<InvoicePdfTemplateAttributes> => {
  return {
    dueDate: invoice.dueDateFormatted,
    dateIssue: invoice.invoiceDateFormatted,
    invoiceNumber: invoice.invoiceNo,

    total: invoice.totalFormatted,
    subtotal: invoice.subtotalFormatted,
    paymentMade: invoice.paymentAmountFormatted,
    dueAmount: invoice.dueAmountFormatted,

    termsConditions: invoice.termsConditions,
    statement: invoice.invoiceMessage,

    isPaid: !!invoice.isFullyPaid,

    lines: invoice.entries.map((entry) => ({
      item: entry.item.name,
      description: entry.description,
      rate: entry.rateFormatted,
      quantity: entry.quantityFormatted,
      total: entry.totalFormatted,
      tax: (entry as { taxCode?: string }).taxCode,
    })),
    taxes: invoice.taxes.map((tax) => ({
      label: tax.name,
      amount: tax.taxRateAmountFormatted,
      // With a single tax, the net is everything the tax was charged on.
      net:
        invoice.taxes.length === 1
          ? invoice.subtotalExludingTaxFormatted
          : undefined,
    })),
    discount: invoice.discountAmountFormatted,
    discountLabel: invoice.discountPercentageFormatted
      ? `Discount [${invoice.discountPercentageFormatted}]`
      : 'Discount',
    customerAddress: contactAddressTextFormat(invoice.customer),
  };
};
