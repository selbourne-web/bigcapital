import { useFormikContext } from 'formik';
import { keyBy } from 'lodash';
import React from 'react';
import styled from 'styled-components';
import { useExpenseFormContext } from './ExpenseFormPageProvider';
import { useExpenseTax } from './utils';
import type { ExpenseFormValues } from './types';
import {
  T,
  TotalLines,
  TotalLine,
  TotalLineBorderStyle,
  TotalLineTextStyle,
} from '@/components';
import { formattedAmount } from '@/utils';

export function ExpenseFormFooterRight() {
  const {
    values: { currencyCode },
  } = useFormikContext<ExpenseFormValues>();
  const { taxRates } = useExpenseFormContext();
  const tax = useExpenseTax();
  const ratesById = React.useMemo(() => keyBy(taxRates, 'id'), [taxRates]);

  return (
    <ExpensesTotalLines>
      <TotalLine
        title={<T id={'expense.label.subtotal'} />}
        value={formattedAmount(tax.subtotal, currencyCode)}
        borderStyle={TotalLineBorderStyle.None}
      />
      {tax.groups.map((group) => (
        <TotalLine
          key={group.taxRateId}
          title={`${ratesById[group.taxRateId]?.name ?? 'Tax'} @ ${
            group.taxRate
          }% on ${formattedAmount(group.taxableAmount, currencyCode)}`}
          value={formattedAmount(group.taxAmount, currencyCode)}
          borderStyle={TotalLineBorderStyle.None}
        />
      ))}
      <TotalLine
        title={<T id={'expense.label.total'} />}
        value={formattedAmount(tax.total, currencyCode)}
        textStyle={TotalLineTextStyle.Bold}
      />
    </ExpensesTotalLines>
  );
}

const ExpensesTotalLines = styled(TotalLines)`
  --x-color-text: #555555;

  .bp4-dark & {
    --x-color-text: var(--color-light-gray4);
  }
  width: 100%;
  color: var(--x-color-text);
`;
