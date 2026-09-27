import { Position } from '@blueprintjs/core';
import { useFormikContext } from 'formik';
import React from 'react';
import intl from 'react-intl-universal';
import styled from 'styled-components';
import { InvoiceExchangeRateInputField } from './components';
import styles from './InvoiceFormHeader.module.scss';
import { InvoiceFormInvoiceNumberField } from './InvoiceFormInvoiceNumberField';
import { useInvoiceFormContext } from './InvoiceFormProvider';
import { customerNameFieldShouldUpdate } from './utils';
import type { InvoiceFormValues } from './utils';
import {
  FFormGroup,
  FormattedMessage as T,
  CustomerDrawerLink,
  FieldRequiredHint,
  CustomersSelect,
  FInputGroup,
  Icon,
  FDateInput,
} from '@/components';
import { useCustomerUpdateExRate } from '@/containers/Entries/withExRateItemEntriesPriceRecalc';
import { useDateInputFormatter } from '@/hooks';

/**
 * Invoice form header fields.
 */
export function InvoiceFormHeaderFields() {
  const dateInputFormatter = useDateInputFormatter();

  return (
    <div className={styles.fields}>
      <div>
        {/* ----------- Customer name ----------- */}
        <InvoiceFormCustomerSelect />

        {/* ----------- Exchange rate ----------- */}
        <InvoiceExchangeRateInputField />
      </div>

      <div className={styles.details}>
        {/* ----------- Invoice number ----------- */}
        <InvoiceFormInvoiceNumberField />

        {/* ----------- Reference ----------- */}
        <FFormGroup name={'referenceNo'} label={intl.get('reference')}>
          <FInputGroup
            name={'referenceNo'}
            data-testId="invoice-reference-input"
          />
        </FFormGroup>

        {/* ----------- Invoice date ----------- */}
        <FFormGroup
          name={'invoiceDate'}
          label={intl.get('invoice_date')}
          labelInfo={<FieldRequiredHint />}
          fastField
        >
          <FDateInput
            name={'invoiceDate'}
            {...dateInputFormatter}
            popoverProps={{
              position: Position.BOTTOM_LEFT,
              minimal: true,
              fill: true,
            }}
            inputProps={{
              leftIcon: <Icon icon={'date-range'} />,
            }}
            fill
            fastField
          />
        </FFormGroup>

        {/* ----------- Due date ----------- */}
        <FFormGroup
          name={'dueDate'}
          label={intl.get('due_date')}
          labelInfo={<FieldRequiredHint />}
          fastField
        >
          <FDateInput
            name={'dueDate'}
            {...dateInputFormatter}
            popoverProps={{
              position: Position.BOTTOM_LEFT,
              minimal: true,
              fill: true,
            }}
            inputProps={{
              leftIcon: <Icon icon={'date-range'} />,
              fill: true,
            }}
            fill
            fastField
          />
        </FFormGroup>
      </div>
    </div>
  );
}

/**
 * Customer select field of the invoice form.
 * @returns {React.ReactNode}
 */
function InvoiceFormCustomerSelect() {
  const { values, setFieldValue } = useFormikContext<InvoiceFormValues>();
  const { customers } = useInvoiceFormContext();

  const updateEntries = useCustomerUpdateExRate();

  // Handles the customer item change.
  const handleItemChange = (customer: { id: number; currencyCode: string }) => {
    // If the customer id has changed change the customer id and currency code.
    if (values.customerId !== customer.id) {
      setFieldValue('customerId', customer.id);
      setFieldValue('currencyCode', customer.currencyCode);
    }
    updateEntries(customer);
  };

  return (
    <FFormGroup
      name={'customerId'}
      label={intl.get('customer_name')}
      labelInfo={<FieldRequiredHint />}
      fastField={true}
    >
      <>
        <CustomersSelect
          name={'customerId'}
          items={customers}
          placeholder={<T id={'select_customer_account'} />}
          onItemChange={handleItemChange}
          allowCreate={true}
          fastField={true}
          shouldUpdate={customerNameFieldShouldUpdate}
          shouldUpdateDeps={{ items: customers }}
          buttonProps={{ 'data-testId': 'invoice-customer-select' }}
        />
        {values.customerId && (
          <CustomerButtonLink customerId={values.customerId}>
            <T id={'view_customer_details'} />
          </CustomerButtonLink>
        )}
      </>
    </FFormGroup>
  );
}

const CustomerButtonLink = styled(CustomerDrawerLink)`
  font-size: 11px;
  margin-top: 6px;
`;
