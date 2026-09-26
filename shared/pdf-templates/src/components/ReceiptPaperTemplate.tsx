import isEmpty from 'lodash/isEmpty';
import { Text } from '../lib/text/Text';
import { Stack } from '../lib/layout/Stack';
import {
  PaperTemplate,
  PaperTemplateProps,
  isZeroAmount,
} from './PaperTemplate';
import {
  DefaultPdfTemplateTerms,
  DefaultPdfTemplateItemDescription,
  DefaultPdfTemplateStatement,
  DefaultPdfTemplateItemName,
  DefaultPdfTemplateAddressBilledTo,
  DefaultPdfTemplateAddressBilledFrom,
} from './_constants';

export interface ReceiptPaperTemplateProps extends PaperTemplateProps {
  // # Company logo
  showCompanyLogo?: boolean;
  companyLogoUri?: string;

  // # Company name
  companyName?: string;

  // Addresses
  showCustomerAddress?: boolean;
  customerAddress?: string;

  showCompanyAddress?: boolean;
  companyAddress?: string;

  billedToLabel?: string;

  // # Subtotal
  subtotal?: string;
  showSubtotal?: boolean;
  subtotalLabel?: string;

  // # Discount
  discount?: string;
  showDiscount?: boolean;
  discountLabel?: string;

  // # Adjustment
  adjustment?: string;
  showAdjustment?: boolean;
  adjustmentLabel?: string;

  // Total
  total?: string;
  showTotal?: boolean;
  totalLabel?: string;

  // Customer Note
  showCustomerNote?: boolean;
  customerNote?: string;
  customerNoteLabel?: string;

  // Terms & Conditions
  showTermsConditions?: boolean;
  termsConditions?: string;
  termsConditionsLabel?: string;

  // Lines
  lines?: Array<{
    item: string;
    description: string;
    rate: string;
    quantity: string;
    discount?: string;
    total: string;
  }>;

  // # Line Discount
  lineDiscountLabel?: string;
  showLineDiscount?: boolean;

  // Receipt Date.
  receiptDateLabel?: string;
  showReceiptDate?: boolean;
  receiptDate?: string;

  // Receipt Number
  receiptNumebr?: string;
  receiptNumberLabel?: string;
  showReceiptNumber?: boolean;

  // Entries
  lineItemLabel?: string;
  lineQuantityLabel?: string;
  lineRateLabel?: string;
  lineTotalLabel?: string;
}

export function ReceiptPaperTemplate({
  // # Colors
  primaryColor,
  secondaryColor,

  // # Company logo
  showCompanyLogo = true,
  companyLogoUri,
  companyName,

  // # Address
  showCustomerAddress = true,
  customerAddress = DefaultPdfTemplateAddressBilledTo,

  showCompanyAddress = true,
  companyAddress = DefaultPdfTemplateAddressBilledFrom,

  billedToLabel = 'Received from',

  // # Total
  total = '$1000.00',
  totalLabel = 'Total',
  showTotal = true,

  // # Discount
  discount = '',
  discountLabel = 'Discount',
  showDiscount = true,

  // # Adjustment
  adjustment = '',
  adjustmentLabel = 'Adjustment',
  showAdjustment = true,

  // # Subtotal
  subtotal = '1000/00',
  subtotalLabel = 'Subtotal',
  showSubtotal = true,

  showCustomerNote = true,
  customerNoteLabel = 'Customer Note',
  customerNote = DefaultPdfTemplateStatement,

  showTermsConditions = true,
  termsConditionsLabel = 'Terms & Conditions',
  termsConditions = DefaultPdfTemplateTerms,

  lines = [
    {
      item: DefaultPdfTemplateItemName,
      description: DefaultPdfTemplateItemDescription,
      rate: '1',
      quantity: '1000',
      total: '$1000.00',
    },
  ],

  // Receipt Number
  showReceiptNumber = true,
  receiptNumberLabel = 'Receipt Number',
  receiptNumebr = '346D3D40-0001',

  // Receipt Date
  receiptDate = 'September 3, 2024',
  showReceiptDate = true,
  receiptDateLabel = 'Receipt Date',

  // Entries
  lineItemLabel = 'Item',
  lineQuantityLabel = 'Qty',
  lineRateLabel = 'Rate',
  lineTotalLabel = 'Amount',

  // # Line Discount
  lineDiscountLabel = 'Discount',
  showLineDiscount = false,
}: ReceiptPaperTemplateProps) {
  return (
    <PaperTemplate primaryColor={primaryColor} secondaryColor={secondaryColor}>
      <Stack spacing={28}>
        <PaperTemplate.DocumentHead
          title={'Receipt'}
          showLogo={showCompanyLogo}
          logoUri={companyLogoUri}
          companyName={companyName}
          showCompanyAddress={showCompanyAddress}
          companyAddress={companyAddress}
          showCustomerAddress={showCustomerAddress}
          customerAddressLabel={billedToLabel}
          customerAddress={customerAddress}
        >
          {showReceiptNumber && (
            <PaperTemplate.TermsItem label={receiptNumberLabel}>
              {receiptNumebr}
            </PaperTemplate.TermsItem>
          )}
          {showReceiptDate && (
            <PaperTemplate.TermsItem label={receiptDateLabel}>
              {receiptDate}
            </PaperTemplate.TermsItem>
          )}
        </PaperTemplate.DocumentHead>

        <Stack spacing={0}>
          <PaperTemplate.Table
            columns={[
              {
                label: lineItemLabel,
                accessor: (data) => (
                  <Text fontWeight={600}>{data.item}</Text>
                ),
                thStyle: { width: '26%' },
              },
              {
                label: 'Description',
                accessor: (data) => <Text>{data.description}</Text>,
                thStyle: { width: '34%' },
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
                {showCustomerNote && !isEmpty(customerNote) && (
                  <PaperTemplate.Statement label={customerNoteLabel}>
                    {customerNote}
                  </PaperTemplate.Statement>
                )}
                {showTermsConditions && !isEmpty(termsConditions) && (
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
              {showTotal && (
                <PaperTemplate.TotalLine
                  label={totalLabel}
                  amount={total}
                  emphasis
                />
              )}
            </PaperTemplate.Totals>
          </PaperTemplate.Summary>
        </Stack>
      </Stack>
    </PaperTemplate>
  );
}
