import { categorizeTransactionsBulk } from '@bigcapital/sdk-ts';
import { Intent } from '@blueprintjs/core';
import { useMutation } from '@tanstack/react-query';
import { Formik, Form, FormikHelpers } from 'formik';
import * as FF from 'fp-ts/function';
import React from 'react';
import styled from 'styled-components';
import {
  tranformToRequest,
  transformToBankRuleRequest,
  useCategorizeTransactionFormInitialValues,
} from './_utils';
import { useCategorizeTransactionBoot } from './CategorizeTransactionBoot';
import { CreateCategorizeTransactionSchema } from './CategorizeTransactionForm.schema';
import { CategorizeTransactionFormContent } from './CategorizeTransactionFormContent';
import { CategorizeTransactionFormFooter } from './CategorizeTransactionFormFooter';
import type { CategorizeTransactionFormValues } from './_utils';
import type { WithBankingActionsProps } from '@/containers/CashFlow/withBankingActions';
import type {
  CategorizeTransactionBody,
  CreateBankRuleBody,
} from '@bigcapital/sdk-ts';
import { AppToaster } from '@/components';
import { useCreateBankRule } from '@/hooks/query/banking';
import { transfromToSnakeCase } from '@/utils';
import { useCategorizeTransactionTabsBoot } from '@/containers/CashFlow/CategorizeTransactionAside/CategorizeTransactionTabsBoot';
import { withBankingActions } from '@/containers/CashFlow/withBankingActions';
import { useApiFetcher } from '@/hooks/useRequest';

interface CategorizeTransactionFormRootProps
  extends Pick<WithBankingActionsProps, 'closeMatchingTransactionAside'> {}

/**
 * Categorize cashflow transaction form dialog content.
 */
function CategorizeTransactionFormRoot({
  // #withBankingActions
  closeMatchingTransactionAside,
}: CategorizeTransactionFormRootProps) {
  const { uncategorizedTransactionIds } = useCategorizeTransactionTabsBoot();
  const { autofillCategorizeValues } = useCategorizeTransactionBoot();
  const isDepositTransaction = !!autofillCategorizeValues?.isDepositTransaction;
  const { mutateAsync: createBankRule } = useCreateBankRule();
  const fetcher = useApiFetcher();
  const { mutateAsync: categorizeBulk } = useMutation<
    void,
    Error,
    CategorizeTransactionBody
  >({
    mutationFn: (body) => categorizeTransactionsBulk(fetcher, body),
  });

  // Form initial values in create and edit mode.
  const initialValues = useCategorizeTransactionFormInitialValues();

  // Callbacks handles form submit.
  const handleFormSubmit = (
    values: CategorizeTransactionFormValues,
    {
      setSubmitting,
      setErrors,
    }: FormikHelpers<CategorizeTransactionFormValues>,
  ) => {
    const _values = tranformToRequest(values, uncategorizedTransactionIds);

    setSubmitting(true);
    categorizeBulk(_values)
      .then(async () => {
        // The categorization already stands on its own, so a rule that fails
        // to save is reported separately rather than as a categorize failure.
        let ruleFailed = false;
        if (values.createRule) {
          try {
            await createBankRule(
              transfromToSnakeCase(
                transformToBankRuleRequest(values, isDepositTransaction),
              ) as unknown as CreateBankRuleBody,
            );
          } catch {
            ruleFailed = true;
          }
        }
        setSubmitting(false);

        AppToaster.show({
          message:
            values.createRule && !ruleFailed
              ? 'The transaction has been categorized and the rule created.'
              : 'The uncategorized transaction has been categorized.',
          intent: Intent.SUCCESS,
        });
        if (ruleFailed) {
          AppToaster.show({
            message:
              'The transaction was categorized, but the rule could not be created. You can add it from Banking > Rules.',
            intent: Intent.WARNING,
          });
        }
        closeMatchingTransactionAside();
      })
      .catch(
        (err: {
          response?: { data?: { errors?: Array<{ type: string }> } };
        }) => {
          setSubmitting(false);
          if (
            err.response?.data?.errors?.some(
              (e) => e.type === 'BRANCH_ID_REQUIRED',
            )
          ) {
            setErrors({ branchId: 'The branch is required.' });
          } else {
            AppToaster.show({
              message: 'Something went wrong!',
              intent: Intent.DANGER,
            });
          }
        },
      );
  };

  return (
    <Formik
      validationSchema={CreateCategorizeTransactionSchema}
      initialValues={initialValues}
      onSubmit={handleFormSubmit}
    >
      <FormRoot>
        <CategorizeTransactionFormContent />
        <CategorizeTransactionFormFooter />
      </FormRoot>
    </Formik>
  );
}

export const CategorizeTransactionForm = FF.pipe(
  CategorizeTransactionFormRoot,
  withBankingActions,
);

const FormRoot = styled(Form)`
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;

  .bp4-form-group .bp4-form-content {
    flex: 1 0;
  }
  .bp4-form-group .bp4-label {
    width: 140px;
  }
  .bp4-form-group {
    margin-bottom: 18px;
  }
`;
