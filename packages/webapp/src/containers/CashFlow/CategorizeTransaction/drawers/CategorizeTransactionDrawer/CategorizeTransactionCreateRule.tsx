import { Classes } from '@blueprintjs/core';
import { useFormikContext } from 'formik';
import React from 'react';
import styled from 'styled-components';
import { useCategorizeTransactionBoot } from './CategorizeTransactionBoot';
import type { CategorizeTransactionFormValues } from './_utils';
import { FCheckbox, FFormGroup, FInputGroup } from '@/components';

/**
 * Lets the person turn this categorization into a bank rule without leaving
 * the form: future transactions on this bank account whose description
 * contains the match text are recognized with the same category and account.
 */
export function CategorizeTransactionCreateRule() {
  const { values } = useFormikContext<CategorizeTransactionFormValues>();
  const { autofillCategorizeValues } = useCategorizeTransactionBoot();
  const isDeposit = !!autofillCategorizeValues?.isDepositTransaction;

  return (
    <Wrapper>
      <FCheckbox
        name={'createRule'}
        label={'Create a rule to categorize similar transactions automatically'}
      />

      {values.createRule && (
        <>
          <FFormGroup name={'ruleName'} label={'Rule name'} fastField inline>
            <FInputGroup name={'ruleName'} fill fastField />
          </FFormGroup>

          <FFormGroup
            name={'ruleMatchText'}
            label={'Description contains'}
            helperText={
              'Trim this to the part that stays the same each time (for example the merchant name) - dates or reference numbers would stop the rule matching again.'
            }
            fastField
            inline
          >
            <FInputGroup name={'ruleMatchText'} fill fastField />
          </FFormGroup>

          <p className={Classes.TEXT_MUTED}>
            Applies to this bank account&apos;s{' '}
            {isDeposit ? 'deposits' : 'withdrawals'}, using the category and
            account chosen above. Matching transactions are suggested for your
            review - nothing is categorized without you.
          </p>
        </>
      )}
    </Wrapper>
  );
}

const Wrapper = styled.div`
  margin-top: 6px;
  padding-top: 14px;
  border-top: 1px solid var(--color-border, rgba(16, 22, 26, 0.15));

  .bp4-control {
    margin-bottom: 14px;
  }
  p {
    font-size: 12px;
    margin: 0 0 18px;
  }
`;
