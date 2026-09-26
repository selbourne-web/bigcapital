import { Stack } from '../lib/layout/Stack';
import {
  PaperTemplate,
  PaperTemplateProps,
} from './PaperTemplate';
import {
  DefaultPdfTemplateAddressBilledFrom,
  DefaultPdfTemplateAddressBilledTo,
} from './_constants';

export interface PaymentReceivedPaperTemplateProps extends PaperTemplateProps {
  // # Company logo
  showCompanyLogo?: boolean;
  companyLogoUri?: string;

  // # Company name
  companyName?: string;

  // Customer address
  showCustomerAddress?: boolean;
  customerAddress?: string;

  // Company address
  showCompanyAddress?: boolean;
  companyAddress?: string;

  billedToLabel?: string;

  // Total.
  total?: string;
  showTotal?: boolean;
  totalLabel?: string;

  // Subtotal.
  subtotal?: string;
  showSubtotal?: boolean;
  subtotalLabel?: string;

  lines?: Array<{
    paidAmount: string;
    invoiceAmount: string;
    invoiceNumber: string;
    invoiceDate?: string;
    dueDate?: string;
    balance?: string;
  }>;

  // Payment details.
  showPaymentMethod?: boolean;
  paymentMethod?: string;
  referenceNumber?: string;
  memo?: string;

  // Issue date.
  paymentReceivedDateLabel?: string;
  showPaymentReceivedDate?: boolean;
  paymentReceivedDate?: string;

  // Payment received number.
  paymentReceivedNumebr?: string;
  paymentReceivedNumberLabel?: string;
  showPaymentReceivedNumber?: boolean;
}

export function PaymentReceivedPaperTemplate({
  // # Colors
  primaryColor,
  secondaryColor,

  // # Company logo
  showCompanyLogo = true,
  companyLogoUri,
  companyName,

  // # Customer address
  showCustomerAddress = true,
  customerAddress = DefaultPdfTemplateAddressBilledTo,

  // # Company address
  showCompanyAddress = true,
  companyAddress = DefaultPdfTemplateAddressBilledFrom,

  billedToLabel = 'Received from',

  total = '$1000.00',
  totalLabel = 'Total',
  showTotal = true,

  subtotal = '1000/00',
  subtotalLabel = 'Subtotal',
  showSubtotal = true,

  lines = [
    {
      invoiceNumber: 'INV-00001',
      invoiceAmount: '$1000.00',
      paidAmount: '$1000.00',
    },
  ],
  showPaymentReceivedNumber = true,
  paymentReceivedNumberLabel = 'Payment Number',
  paymentReceivedNumebr = '346D3D40-0001',

  paymentReceivedDate = 'September 3, 2024',
  showPaymentReceivedDate = true,
  paymentReceivedDateLabel = 'Payment Date',

  showPaymentMethod = true,
  paymentMethod = '',
  referenceNumber = '',
  memo = '',
}: PaymentReceivedPaperTemplateProps) {
  const hasInvoiceDates = lines.some((line) => !!line.invoiceDate);
  const hasBalance = lines.some((line) => !!line.balance);
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
          {showPaymentReceivedDate && (
            <PaperTemplate.TermsItem label={paymentReceivedDateLabel}>
              {paymentReceivedDate}
            </PaperTemplate.TermsItem>
          )}
          {showPaymentMethod && paymentMethod && (
            <PaperTemplate.TermsItem label={'Payment method'}>
              {paymentMethod}
            </PaperTemplate.TermsItem>
          )}
          {referenceNumber && (
            <PaperTemplate.TermsItem label={'Reference no'}>
              {referenceNumber}
            </PaperTemplate.TermsItem>
          )}
          {showPaymentReceivedNumber && (
            <PaperTemplate.TermsItem label={paymentReceivedNumberLabel}>
              {paymentReceivedNumebr}
            </PaperTemplate.TermsItem>
          )}
        </PaperTemplate.DocumentHead>

        <Stack spacing={0}>
          <PaperTemplate.Table
            columns={[
              { label: 'Invoice number', accessor: 'invoiceNumber' },
              {
                label: 'Invoice date',
                accessor: 'invoiceDate',
                visible: hasInvoiceDates,
              },
              { label: 'Due date', accessor: 'dueDate', visible: hasInvoiceDates },
              {
                label: 'Original amount',
                accessor: 'invoiceAmount',
                align: 'right',
              },
              {
                label: 'Balance',
                accessor: 'balance',
                align: 'right',
                visible: hasBalance,
              },
              { label: 'Payment', accessor: 'paidAmount', align: 'right' },
            ]}
            data={lines}
          />
          <PaperTemplate.Divider />

          <PaperTemplate.Summary
            notes={memo ? <>{`Memo: ${memo}`}</> : undefined}
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
