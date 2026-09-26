import {
  PaperTemplate,
  PaperTemplateProps,
} from './PaperTemplate';
import { Text } from '../lib/text/Text';
import { Stack } from '../lib/layout/Stack';
import {
  DefaultPdfTemplateTerms,
  DefaultPdfTemplateItemDescription,
  DefaultPdfTemplateItemName,
  DefaultPdfTemplateAddressBilledTo,
  DefaultPdfTemplateAddressBilledFrom,
} from './_constants';

interface CreditNoteLine {
  item?: string;
  description?: string;
  quantity?: string;
  rate?: string;
  total?: string;
}

export interface CreditNotePaperTemplateProps extends PaperTemplateProps {
  primaryColor?: string;
  secondaryColor?: string;

  // Company
  showCompanyLogo?: boolean;
  companyLogoUri?: string;

  companyName?: string;

  // Credit Note number
  showCreditNoteNumber?: boolean;
  creditNoteNumebr?: string;
  creditNoteNumberLabel?: string;

  // Credit Note date
  showCreditNoteDate?: boolean;
  creditNoteDate?: string;
  creditNoteDateLabel?: string;

  // Address
  showCustomerAddress?: boolean;
  customerAddress?: string;

  showCompanyAddress?: boolean;
  companyAddress?: string;

  billedToLabel?: string;

  // Entries
  lineItemLabel?: string;
  lineQuantityLabel?: string;
  lineRateLabel?: string;
  lineTotalLabel?: string;

  // Subtotal
  showSubtotal?: boolean;
  subtotalLabel?: string;
  subtotal?: string;

  // Total
  showTotal?: boolean;
  totalLabel?: string;
  total?: string;

  // Customer Note
  showCustomerNote?: boolean;
  customerNote?: string;
  customerNoteLabel?: string;

  // Terms & Conditions
  showTermsConditions?: boolean;
  termsConditions?: string;
  termsConditionsLabel?: string;

  lines?: Array<CreditNoteLine>;
}

export function CreditNotePaperTemplate({
  // # Colors
  primaryColor,
  secondaryColor,

  showCompanyLogo = true,
  companyLogoUri = '',
  companyName,

  // # Credit Note number
  creditNoteNumberLabel = 'Credit Note Number',
  creditNoteNumebr = '346D3D40-0001',
  showCreditNoteNumber = true,

  // # Credit Note date
  creditNoteDate = 'September 3, 2024',
  creditNoteDateLabel = 'Credit Note Date',
  showCreditNoteDate = true,

  // Address
  showCustomerAddress = true,
  customerAddress = DefaultPdfTemplateAddressBilledTo,

  showCompanyAddress = true,
  companyAddress = DefaultPdfTemplateAddressBilledFrom,

  billedToLabel = 'Credit to',

  // Entries
  lineItemLabel = 'Item',
  lineQuantityLabel = 'Qty',
  lineRateLabel = 'Rate',
  lineTotalLabel = 'Amount',

  // Subtotal
  subtotalLabel = 'Subtotal',
  showSubtotal = true,
  subtotal = '1000.00',

  // Total
  totalLabel = 'Total',
  showTotal = true,
  total = '$1000.00',

  // Customer Note
  showCustomerNote = true,
  customerNote = '',
  customerNoteLabel = 'Customer Note',

  // Terms & Conditions
  termsConditionsLabel = 'Terms & Conditions',
  showTermsConditions = true,
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
  ...props
}: CreditNotePaperTemplateProps) {
  return (
    <PaperTemplate
      primaryColor={primaryColor}
      secondaryColor={secondaryColor}
      {...props}
    >
      <Stack spacing={28}>
        <PaperTemplate.DocumentHead
          title={'Credit Note'}
          showLogo={showCompanyLogo}
          logoUri={companyLogoUri}
          companyName={companyName}
          showCompanyAddress={showCompanyAddress}
          companyAddress={companyAddress}
          showCustomerAddress={showCustomerAddress}
          customerAddressLabel={billedToLabel}
          customerAddress={customerAddress}
        >
          {showCreditNoteNumber && (
            <PaperTemplate.TermsItem label={creditNoteNumberLabel}>
              {creditNoteNumebr}
            </PaperTemplate.TermsItem>
          )}
          {showCreditNoteDate && (
            <PaperTemplate.TermsItem label={creditNoteDateLabel}>
              {creditNoteDate}
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
              { label: lineTotalLabel, accessor: 'total', align: 'right' },
            ]}
            data={lines}
          />
          <PaperTemplate.Divider />

          <PaperTemplate.Summary
            notes={
              <>
                {showCustomerNote && customerNote && (
                  <PaperTemplate.Statement label={customerNoteLabel}>
                    {customerNote}
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
