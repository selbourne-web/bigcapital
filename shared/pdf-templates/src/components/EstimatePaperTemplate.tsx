import isEmpty from 'lodash/isEmpty';
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
import {
  PaperTemplate,
  PaperTemplateProps,
  isZeroAmount,
} from './PaperTemplate';

export interface EstimatePaperTemplateProps extends PaperTemplateProps {
  // # Company
  showCompanyLogo?: boolean;
  companyLogoUri?: string;

  // # Estimate number
  estimateNumebr?: string;
  estimateNumberLabel?: string;
  showEstimateNumber?: boolean;

  // # Expiration date
  expirationDate?: string;
  showExpirationDate?: boolean;
  expirationDateLabel?: string;

  // # Estimate date
  estimateDateLabel?: string;
  showEstimateDate?: boolean;
  estimateDate?: string;

  // # Customer name
  companyName?: string;

  // Address
  showCustomerAddress?: boolean;
  customerAddress?: string;

  showCompanyAddress?: boolean;
  companyAddress?: string;
  billedToLabel?: string;

  // Total
  total?: string;
  showTotal?: boolean;
  totalLabel?: string;

  // # Discount
  discount?: string;
  showDiscount?: boolean;
  discountLabel?: string;

  // # Adjustment
  adjustment?: string;
  showAdjustment?: boolean;
  adjustmentLabel?: string;

  // # Subtotal
  subtotal?: string;
  showSubtotal?: boolean;
  subtotalLabel?: string;

  // # Statements
  showCustomerNote?: boolean;
  customerNote?: string;
  customerNoteLabel?: string;

  // # Terms & conditions
  showTermsConditions?: boolean;
  termsConditions?: string;
  termsConditionsLabel?: string;

  lines?: Array<{
    item: string;
    description: string;
    rate: string;
    quantity: string;
    total: string;
  }>;

  // Lines
  lineItemLabel?: string;
  lineQuantityLabel?: string;
  lineRateLabel?: string;
  lineTotalLabel?: string;

  // # Line Discount
  lineDiscountLabel?: string;
  showLineDiscount?: boolean;
}

export function EstimatePaperTemplate({
  primaryColor,
  secondaryColor,

  // # Company logo
  showCompanyLogo = true,
  companyLogoUri = '',
  companyName,

  // # Company address
  companyAddress = DefaultPdfTemplateAddressBilledFrom,
  showCompanyAddress = true,

  // # Customer address
  customerAddress = DefaultPdfTemplateAddressBilledTo,
  showCustomerAddress = true,
  billedToLabel = 'Address',

  // # Total
  total = '$1000.00',
  totalLabel = 'Total',
  showTotal = true,

  // # Discount
  discount = '0.00',
  discountLabel = 'Discount',
  showDiscount = true,

  // # Subtotal
  subtotal = '1000/00',
  subtotalLabel = 'Subtotal',
  showSubtotal = true,

  // # Adjustment
  adjustment = '',
  showAdjustment = true,
  adjustmentLabel = 'Adjustment',

  // # Customer Note
  showCustomerNote = true,
  customerNote = DefaultPdfTemplateStatement,
  customerNoteLabel = 'Customer Note',

  // # Terms & Conditions
  showTermsConditions = true,
  termsConditions = DefaultPdfTemplateTerms,
  termsConditionsLabel = 'Terms & Conditions',

  lines = [
    {
      item: DefaultPdfTemplateItemName,
      description: DefaultPdfTemplateItemDescription,
      rate: '1',
      quantity: '1000',
      total: '$1000.00',
    },
  ],

  // Estimate number
  showEstimateNumber = true,
  estimateNumberLabel = 'Estimate Number',
  estimateNumebr = '346D3D40-0001',

  // Estimate date
  estimateDate = 'September 3, 2024',
  showEstimateDate = true,
  estimateDateLabel = 'Estimate Date',

  // Expiration date
  expirationDateLabel = 'Expiration Date',
  showExpirationDate = true,
  expirationDate = 'September 3, 2024',

  // Entries
  lineItemLabel = 'Item',
  lineQuantityLabel = 'Qty',
  lineRateLabel = 'Rate',
  lineTotalLabel = 'Amount',

  // # Line Discount
  lineDiscountLabel = 'Discount',
  showLineDiscount = false,
}: EstimatePaperTemplateProps) {
  return (
    <PaperTemplate primaryColor={primaryColor} secondaryColor={secondaryColor}>
      <Stack spacing={28}>
        <PaperTemplate.DocumentHead
          title={'Estimate'}
          showLogo={showCompanyLogo}
          logoUri={companyLogoUri}
          companyName={companyName}
          showCompanyAddress={showCompanyAddress}
          companyAddress={companyAddress}
          showCustomerAddress={showCustomerAddress}
          customerAddressLabel={billedToLabel}
          customerAddress={customerAddress}
        >
          {showEstimateNumber && (
            <PaperTemplate.TermsItem label={estimateNumberLabel}>
              {estimateNumebr}
            </PaperTemplate.TermsItem>
          )}
          {showEstimateDate && (
            <PaperTemplate.TermsItem label={estimateDateLabel}>
              {estimateDate}
            </PaperTemplate.TermsItem>
          )}
          {showExpirationDate && (
            <PaperTemplate.TermsItem label={expirationDateLabel}>
              {expirationDate}
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

        <PaperTemplate.Signatures
          labels={['Accepted by', 'Accepted date']}
        />
      </Stack>
    </PaperTemplate>
  );
}
