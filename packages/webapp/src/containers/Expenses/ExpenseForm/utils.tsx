import { computeExpenseTax } from '@bigcapital/utils';
import { Intent } from '@blueprintjs/core';
import { useFormikContext } from 'formik';
import * as FF from 'fp-ts/function';
import { first, keyBy } from 'lodash';
import moment from 'moment';
import React from 'react';
import intl from 'react-intl-universal';
import { useExpenseFormContext } from './ExpenseFormPageProvider';
import type {
  ExpenseEntry,
  ExpenseErrorResponse,
  ExpenseFormValues,
} from './types';
import type { Expense } from '@bigcapital/sdk-ts';
import { AppToaster } from '@/components';
import {
  transformAttachmentsToForm,
  transformAttachmentsToRequest,
} from '@/containers/Attachments/utils';
import { useCurrentOrganizationBaseCurrency } from '@/hooks/query';
import { TaxType } from '@/interfaces/TaxRates';
import {
  defaultFastFieldShouldUpdate,
  transformToForm,
  repeatValue,
  ensureEntriesHasEmptyLine,
  orderingLinesIndexes,
  formattedAmount,
} from '@/utils';

const ERROR = {
  EXPENSE_ALREADY_PUBLISHED: 'EXPENSE.ALREADY.PUBLISHED',
  ENTRIES_ALLOCATED_COST_COULD_NOT_DELETED:
    'ENTRIES_ALLOCATED_COST_COULD_NOT_DELETED',
};

export const MIN_LINES_NUMBER = 1;

export const defaultExpenseEntry: ExpenseEntry = {
  amount: '',
  expenseAccountId: '',
  description: '',
  landedCost: 0,
  isTax: 0,
  taxRateId: '',
};

export const defaultExpense: ExpenseFormValues = {
  paymentAccountId: '',
  beneficiary: '',
  payeeId: '',
  paymentDate: moment(new Date()).format('YYYY-MM-DD'),
  description: '',
  referenceNo: '',
  currencyCode: '',
  publish: '',
  branchId: '',
  exchangeRate: 1,
  inclusiveExclusiveTax: TaxType.Exclusive,
  categories: [...repeatValue(defaultExpenseEntry, MIN_LINES_NUMBER)],
  attachments: [],
};

/**
 * Transform API errors in toasts messages.
 */
export const transformErrors = (
  errors: ExpenseErrorResponse[],
  { setErrors }: { setErrors: (errors: any) => void },
) => {
  const hasError = (errorType: string) =>
    errors.some((e) => e.type === errorType);

  if (hasError(ERROR.EXPENSE_ALREADY_PUBLISHED)) {
    setErrors(
      AppToaster.show({
        message: intl.get('the_expense_is_already_published'),
      }),
    );
  }
  if (hasError(ERROR.ENTRIES_ALLOCATED_COST_COULD_NOT_DELETED)) {
    setErrors(
      AppToaster.show({
        intent: Intent.DANGER,
        message: 'ENTRIES_ALLOCATED_COST_COULD_NOT_DELETED',
      }),
    );
  }
};

/**
 * Transformes the expense to form initial values in edit mode.
 */
export const transformToEditForm = (
  expense: Expense,
  defaultValues: ExpenseFormValues,
  linesNumber = MIN_LINES_NUMBER,
): ExpenseFormValues => {
  const expenseEntry = defaultValues.categories[0];
  const initialEntries = [
    ...expense.categories.map((category) => ({
      ...transformToForm(category, expenseEntry),
    })),
    ...repeatValue(
      expenseEntry,
      Math.max(linesNumber - expense.categories.length, 0),
    ),
  ];
  const categories = FF.pipe(
    initialEntries,
    ensureEntriesHasEmptyLine(MIN_LINES_NUMBER, expenseEntry),
  ) as unknown as ExpenseEntry[];

  const attachments = transformAttachmentsToForm(expense);

  return {
    ...transformToForm(expense, defaultValues),
    inclusiveExclusiveTax: (expense as { isInclusiveTax?: boolean })
      .isInclusiveTax
      ? TaxType.Inclusive
      : TaxType.Exclusive,
    categories,
    attachments,
  } as ExpenseFormValues;
};

/**
 * Detarmine vendors fast-field should update.
 */
export const vendorsFieldShouldUpdate = (newProps: any, oldProps: any) => {
  return (
    newProps.shouldUpdateDeps.items !== oldProps.shouldUpdateDeps.items ||
    defaultFastFieldShouldUpdate(newProps, oldProps)
  );
};

/**
 * Detarmine accounts fast-field should update.
 */
export const accountsFieldShouldUpdate = (newProps: any, oldProps: any) => {
  return (
    newProps.items !== oldProps.items ||
    defaultFastFieldShouldUpdate(newProps, oldProps)
  );
};

/**
 * Filter expense entries that has no amount or expense account.
 */
export const filterNonZeroEntries = (categories: ExpenseEntry[]) => {
  return categories.filter(
    (category) => category.amount && category.expenseAccountId,
  );
};

/**
 * Transformes the form values to request body.
 */
export const transformFormValuesToRequest = (values: ExpenseFormValues) => {
  const categories = filterNonZeroEntries(values.categories);
  const attachments = transformAttachmentsToRequest(values);

  const { payeeId, inclusiveExclusiveTax, ...rest } = values;

  return {
    ...rest,
    // A blank payee is left out, not sent as an empty string.
    ...(payeeId !== '' && payeeId != null && { payeeId }),
    isInclusiveTax: inclusiveExclusiveTax === TaxType.Inclusive,
    categories: FF.pipe(
      categories.map(({ taxRateId, ...category }) => ({
        ...category,
        // A line without a tax rate is sent without one, not as ''.
        ...(taxRateId !== '' && taxRateId != null && { taxRateId }),
      })),
      orderingLinesIndexes,
    ),
    attachments,
  };
};

export const useSetPrimaryBranchToForm = () => {
  const { setFieldValue } = useFormikContext<ExpenseFormValues>();
  const { branches, isBranchesSuccess, isNewMode } = useExpenseFormContext();

  React.useEffect(() => {
    if (isBranchesSuccess && isNewMode) {
      const primaryBranch = branches.find((b) => b.primary) || first(branches);

      if (primaryBranch) {
        setFieldValue('branchId', primaryBranch.id);
      }
    }
  }, [isBranchesSuccess, setFieldValue, branches, isNewMode]);
};

/**
 * The expense's tax, worked out the same way the server posts it (shared
 * `computeExpenseTax`), so the totals shown always match what is saved.
 */
export const useExpenseTax = () => {
  const {
    values: { categories, inclusiveExclusiveTax },
  } = useFormikContext<ExpenseFormValues>();
  const { taxRates } = useExpenseFormContext();

  return React.useMemo(() => {
    const ratesById = keyBy(taxRates, 'id');

    return computeExpenseTax(
      categories.map((category) => ({
        amount: Number(category.amount) || 0,
        taxRateId: category.taxRateId ? Number(category.taxRateId) : null,
        taxRate: category.taxRateId
          ? Number(ratesById[category.taxRateId]?.rate ?? 0)
          : null,
      })),
      inclusiveExclusiveTax === TaxType.Inclusive,
    );
  }, [categories, inclusiveExclusiveTax, taxRates]);
};

/**
 * Retrieves the expense subtotal (tax excluded).
 * @returns {number}
 */
export const useExpenseSubtotal = () => {
  return useExpenseTax().subtotal;
};

/**
 * Retrieves the expense subtotal formatted.
 * @returns {string}
 */
export const useExpenseSubtotalFormatted = () => {
  const subtotal = useExpenseSubtotal();
  const {
    values: { currencyCode },
  } = useFormikContext<ExpenseFormValues>();

  return formattedAmount(subtotal, currencyCode);
};

/**
 * Retrieves the expense total.
 * @returns {number}
 */
export const useExpenseTotal = () => {
  return useExpenseTax().total;
};

/**
 * Retrieves the expense total formatted.
 * @returns {string}
 */
export const useExpenseTotalFormatted = () => {
  const total = useExpenseTotal();
  const {
    values: { currencyCode },
  } = useFormikContext<ExpenseFormValues>();

  return formattedAmount(total, currencyCode);
};

/**
 * Detarmines whether the expenses has foreign .
 * @returns {boolean}
 */
export const useExpensesIsForeign = () => {
  const { values } = useFormikContext<ExpenseFormValues>();
  const baseCurrency = useCurrentOrganizationBaseCurrency();

  const isForeignExpenses = React.useMemo(
    () => values.currencyCode !== baseCurrency,
    [values.currencyCode, baseCurrency],
  );
  return isForeignExpenses;
};
