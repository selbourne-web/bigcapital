import { toNumber } from 'lodash';
import { useCategorizeTransactionBoot } from './CategorizeTransactionBoot';
import type { GetAutofillCategorizeTransaction } from '@/hooks/query/banking';
import type { CategorizeTransactionBody } from '@bigcapital/sdk-ts';
import { transformToForm } from '@/utils';

export interface CategorizeTransactionFormValues {
  amount: string;
  date: string;
  creditAccountId: string;
  debitAccountId: string;
  exchangeRate: string;
  transactionType: string;
  referenceNo: string;
  description: string;
  branchId: string | number | null;
  createRule: boolean;
  ruleName: string;
  ruleMatchText: string;
}

// Default initial form values.
export const defaultInitialValues: CategorizeTransactionFormValues = {
  amount: '',
  date: '',
  creditAccountId: '',
  debitAccountId: '',
  exchangeRate: '1',
  transactionType: '',
  referenceNo: '',
  description: '',
  branchId: '',
  createRule: false,
  ruleName: '',
  ruleMatchText: '',
};

/**
 * The bank's own description for the transaction, used to suggest the rule's
 * match text (the generated SDK type doesn't list `bankDescription` yet).
 */
export const getSuggestedRuleText = (
  autofill: GetAutofillCategorizeTransaction | null | undefined,
): string => {
  const { bankDescription } = (autofill ?? {}) as {
    bankDescription?: string | null;
  };
  return (bankDescription || '').trim();
};

/**
 * Builds a bank rule that repeats this categorization for future
 * transactions from the same bank account whose description matches.
 */
export const transformToBankRuleRequest = (
  formValues: CategorizeTransactionFormValues,
  isDepositTransaction: boolean,
) => ({
  name: formValues.ruleName.trim(),
  order: 0,
  applyIfAccountId: toNumber(formValues.debitAccountId),
  applyIfTransactionType: isDepositTransaction ? 'deposit' : 'withdrawal',
  conditionsType: 'and',
  conditions: [
    {
      field: 'description',
      comparator: 'contains',
      value: formValues.ruleMatchText.trim(),
    },
  ],
  assignCategory: formValues.transactionType,
  assignAccountId: toNumber(formValues.creditAccountId),
});

export const transformToCategorizeForm = (
  autofillCategorizeTransaction:
    | GetAutofillCategorizeTransaction
    | null
    | undefined,
) => {
  return transformToForm(autofillCategorizeTransaction, defaultInitialValues);
};

export const tranformToRequest = (
  formValues: CategorizeTransactionFormValues,
  uncategorizedTransactionIds: Array<number>,
): CategorizeTransactionBody => {
  return {
    date: formValues.date,
    creditAccountId: toNumber(formValues.creditAccountId) ?? 0,
    referenceNo: formValues.referenceNo,
    transactionType: formValues.transactionType,
    exchangeRate: toNumber(formValues.exchangeRate) ?? 1,
    description: formValues.description,
    branchId: toNumber(formValues.branchId),
    uncategorizedTransactionIds,
  };
};

/**
 * Categorize transaction form initial values.
 */
export const useCategorizeTransactionFormInitialValues =
  (): CategorizeTransactionFormValues => {
    const { primaryBranch, autofillCategorizeValues } =
      useCategorizeTransactionBoot();
    const suggestedRuleText = getSuggestedRuleText(autofillCategorizeValues);

    return {
      ...defaultInitialValues,
      /**
       * We only care about the fields in the form. Previously unfilled optional
       * values such as `notes` come back from the API as null, so remove those
       * as well.
       */
      ...transformToCategorizeForm(autofillCategorizeValues),

      /** Assign the primary branch id as default value. */
      branchId: primaryBranch?.id || null,

      ruleName: suggestedRuleText,
      ruleMatchText: suggestedRuleText,
    };
  };
