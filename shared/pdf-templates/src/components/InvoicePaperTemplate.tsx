import { isEmpty } from 'lodash';
import {
  PaperTemplate,
  PaperTemplateProps,
  isZeroAmount,
  PaperTemplateTotalBorder,
} from './PaperTemplate';
import { Text } from '../lib/text/Text';
import { Stack } from '../lib/layout/Stack';
import {
  DefaultPdfTemplateTerms,
  DefaultPdfTemplateItemDescription,
  DefaultPdfTemplateStatement,
  DefaultPdfTemplateItemName,
  DefaultPdfTemplateAddressBilledTo,
  DefaultPdfTemplateAddressBilledFrom,
} from './_constants';

interface InvoiceLine {
  /** Date the service was provided, already formatted. */
  serviceDate?: string;
  item?: string;
  description?: string;
  quantity?: string;
  rate?: string;
  total?: string;
  discount?: string;
  /** Tax label of the line, for example "Exempt" or "VAT 17.5%". */
  tax?: string;
}

interface InvoiceTaxLine {
  label: string;
  amount: string;
  /** The net amount the tax applies to. */
  net?: string;
}

export interface InvoicePaperTemplateProps extends PaperTemplateProps {
  primaryColor?: string;
  secondaryColor?: string;

  // Company
  showCompanyLogo?: boolean;
  companyLogoUri?: string;

  // Invoice number
  showInvoiceNumber?: boolean;
  invoiceNumber?: string;
  invoiceNumberLabel?: string;

  // Date of issue
  showDateIssue?: boolean;
  dateIssue?: string;
  dateIssueLabel?: string;

  // Due date
  showDueDate?: boolean;
  dueDate?: string;
  dueDateLabel?: string;

  companyName?: string;
  bigtitle?: string;

  // Address
  showCustomerAddress?: boolean;
  customerAddress?: string;

  showCompanyAddress?: boolean;
  companyAddress?: string;

  billedToLabel?: string;

  // Entries
  lineItemLabel?: string;
  lineDescriptionLabel?: string;
  lineTaxLabel?: string;
  lineQuantityLabel?: string;
  lineRateLabel?: string;
  lineTotalLabel?: string;

  // # Line Discount
  lineDiscountLabel?: string;
  showLineDiscount?: boolean;

  // Total
  showTotal?: boolean;
  totalLabel?: string;
  total?: string;

  // Discount
  showDiscount?: boolean;
  discountLabel?: string;
  discount?: string;

  // Adjustment
  showAdjustment?: boolean;
  adjustmentLabel?: string;
  adjustment?: string;

  // Subtotal
  showSubtotal?: boolean;
  subtotalLabel?: string;
  subtotal?: string;

  // Payment made
  showPaymentMade?: boolean;
  paymentMadeLabel?: string;
  paymentMade?: string;

  showTaxes?: boolean;
  taxSummaryLabel?: string;
  showTaxSummary?: boolean;

  // Due Amount
  showDueAmount?: boolean;
  dueAmountLabel?: string;
  dueAmount?: string;

  /** Marks the invoice as settled with a green "PAID". */
  isPaid?: boolean;
  paidLabel?: string;

  // Footer
  termsConditionsLabel?: string;
  showTermsConditions?: boolean;
  termsConditions?: string;

  // Statement
  statementLabel?: string;
  showStatement?: boolean;
  statement?: string;

  /** Small centred text at the bottom of the page. */
  footerText?: string;

  lines?: Array<InvoiceLine>;
  taxes?: Array<InvoiceTaxLine>;
}

export function InvoicePaperTemplate({
  // # Colors
  primaryColor,
  secondaryColor,

  showCompanyLogo = true,
  companyLogoUri = '',
  companyName,

  // # Due date
  dueDate = 'September 3, 2024',
  dueDateLabel = 'Date due',
  showDueDate = true,

  // # Issue date.
  dateIssue = 'September 3, 2024',
  dateIssueLabel = 'Date of issue',
  showDateIssue = true,

  // Invoice #,
  invoiceNumberLabel = 'Invoice number',
  invoiceNumber = '346D3D40-0001',
  showInvoiceNumber = true,

  // Address
  showCustomerAddress = true,
  customerAddress = DefaultPdfTemplateAddressBilledTo,

  showCompanyAddress = true,
  companyAddress = DefaultPdfTemplateAddressBilledFrom,

  billedToLabel = 'Bill to',

  // Entries
  lineItemLabel = 'Item',
  lineDescriptionLabel = 'Description',
  lineTaxLabel = 'Tax',
  lineQuantityLabel = 'Qty',
  lineRateLabel = 'Rate',
  lineTotalLabel = 'Amount',

  totalLabel = 'Total',
  subtotalLabel = 'Subtotal',
  discountLabel = 'Discount',
  adjustmentLabel = 'Adjustment',
  paymentMadeLabel = 'Payment Made',
  dueAmountLabel = 'Balance Due',

  // # Line Discount
  lineDiscountLabel = 'Discount',
  showLineDiscount = false,

  // Totals
  showTotal = true,
  total = '$662.75',

  showSubtotal = true,
  showDiscount = true,
  showTaxes = true,
  showPaymentMade = true,
  showDueAmount = true,
  showAdjustment = true,

  subtotal = '630.00',
  discount = '0.00',
  adjustment = '',
  paymentMade = '100.00',
  dueAmount = '$562.75',

  isPaid = false,
  paidLabel = 'PAID',

  // Footer paragraphs.
  termsConditionsLabel = 'Terms & Conditions',
  showTermsConditions = true,
  termsConditions = DefaultPdfTemplateTerms,

  footerText = '',

  lines = [
    {
      item: DefaultPdfTemplateItemName,
      description: DefaultPdfTemplateItemDescription,
      rate: '1',
      quantity: '1000',
      total: '$1000.00',
    },
  ],
  taxes = [
    { label: 'Sample Tax1 (4.70%)', amount: '11.75' },
    { label: 'Sample Tax2 (7.00%)', amount: '21.74' },
  ],
  taxSummaryLabel = 'Tax summary',
  showTaxSummary = true,

  // # Statement
  statementLabel = 'Statement',
  showStatement = true,
  statement = DefaultPdfTemplateStatement,
  ...props
}: InvoicePaperTemplateProps) {
  const hasLineTax = lines.some((line) => !isEmpty(line.tax));
  const hasLineDate = lines.some((line) => !isEmpty(line.serviceDate));

  return (
    <PaperTemplate
      primaryColor={primaryColor}
      secondaryColor={secondaryColor}
      {...props}
    >
      <Stack spacing={28}>
        <PaperTemplate.DocumentHead
          title={'Invoice'}
          showLogo={showCompanyLogo}
          logoUri={companyLogoUri}
          companyName={companyName}
          showCompanyAddress={showCompanyAddress}
          companyAddress={companyAddress}
          showCustomerAddress={showCustomerAddress}
          customerAddressLabel={billedToLabel}
          customerAddress={customerAddress}
        >
          {showInvoiceNumber && (
            <PaperTemplate.TermsItem label={invoiceNumberLabel}>
              {invoiceNumber}
            </PaperTemplate.TermsItem>
          )}
          {showDateIssue && (
            <PaperTemplate.TermsItem label={dateIssueLabel}>
              {dateIssue}
            </PaperTemplate.TermsItem>
          )}
          {showDueDate && (
            <PaperTemplate.TermsItem label={dueDateLabel}>
              {dueDate}
            </PaperTemplate.TermsItem>
          )}
        </PaperTemplate.DocumentHead>

        <Stack spacing={0}>
          <PaperTemplate.Table
            columns={[
              {
                label: 'Date',
                accessor: (data) => (
                  <span style={{ whiteSpace: 'nowrap' }}>
                    {data.serviceDate}
                  </span>
                ),
                visible: hasLineDate,
                thStyle: { width: '14%' },
              },
              {
                label: lineItemLabel,
                accessor: (data) => <Text fontWeight={600}>{data.item}</Text>,
                thStyle: { width: '24%' },
              },
              {
                label: lineDescriptionLabel,
                accessor: (data) => <Text>{data.description}</Text>,
                thStyle: { width: '34%' },
              },
              {
                label: lineTaxLabel,
                accessor: 'tax',
                align: 'right',
                visible: hasLineTax,
              },
              {
                label: lineQuantityLabel,
                accessor: 'quantity',
                align: 'right',
              },
              { label: lineRateLabel, accessor: 'rate', align: 'right' },
              {
                label: lineDiscountLabel,
                accessor: 'discount',
                align: 'right',
                visible: showLineDiscount,
              },
              { label: lineTotalLabel, accessor: 'total', align: 'right' },
            ]}
            data={lines}
          />
          <PaperTemplate.Divider />

          <PaperTemplate.Summary
            notes={
              <>
                {showStatement && statement && (
                  <PaperTemplate.Statement label={statementLabel}>
                    {statement}
                  </PaperTemplate.Statement>
                )}
                {showTermsConditions && termsConditions && (
                  <PaperTemplate.Statement label={termsConditionsLabel}>
                    {termsConditions}
                  </PaperTemplate.Statement>
                )}
              </>
            }
          >
            <PaperTemplate.Totals>
              {showSubtotal && (
                <PaperTemplate.TotalLine
                  label={subtotalLabel}
                  amount={subtotal}
                />
              )}
              {showDiscount && !isZeroAmount(discount) && (
                <PaperTemplate.TotalLine
                  label={discountLabel}
                  amount={discount}
                />
              )}
              {showAdjustment && !isZeroAmount(adjustment) && (
                <PaperTemplate.TotalLine
                  label={adjustmentLabel}
                  amount={adjustment}
                />
              )}
              {showTaxes &&
                taxes.map((tax, index) => (
                  <PaperTemplate.TotalLine
                    key={index}
                    label={tax.label}
                    amount={tax.amount}
                  />
                ))}
              {showTotal && (
                <PaperTemplate.TotalLine
                  label={totalLabel}
                  amount={total}
                  border={PaperTemplateTotalBorder.Gray}
                />
              )}
              {showPaymentMade && (
                <PaperTemplate.TotalLine
                  label={paymentMadeLabel}
                  amount={paymentMade}
                />
              )}
              {showDueAmount && (
                <PaperTemplate.TotalLine
                  label={dueAmountLabel}
                  amount={dueAmount}
                  emphasis
                />
              )}
              {isPaid && <PaperTemplate.PaidStamp label={paidLabel} />}
            </PaperTemplate.Totals>
          </PaperTemplate.Summary>
        </Stack>

        {showTaxes && showTaxSummary && (
          <PaperTemplate.TaxSummary label={taxSummaryLabel} taxes={taxes} />
        )}
      </Stack>

      <PaperTemplate.Footer>{footerText}</PaperTemplate.Footer>
    </PaperTemplate>
  );
}
