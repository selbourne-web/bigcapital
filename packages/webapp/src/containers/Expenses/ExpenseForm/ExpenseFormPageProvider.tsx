import { css } from '@emotion/css';
import React, { createContext } from 'react';
import type { ExpenseFormContext } from './types';
import type { SettingsGroup } from '@bigcapital/sdk-ts';
import { DashboardInsider } from '@/components/Dashboard';
import { Features } from '@/constants';
import {
  useCurrencies,
  useVendors,
  useExpense,
  useAccounts,
  useBranches,
  useCreateExpense,
  useEditExpense,
  useSettingsExpenses,
} from '@/hooks/query';
import { useTaxRates } from '@/hooks/query/tax-rates';
import { useFeatureCan } from '@/hooks/state';

const ExpenseFormPageContext = createContext<ExpenseFormContext | undefined>(
  undefined,
);

type ExpenseFormPageProviderProps = {
  expenseId: number;
  query?: Record<string, any>;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'children'>;

/**
 * Accounts chart data provider.
 */
function ExpenseFormPageProvider({
  query,
  expenseId,
  ...props
}: ExpenseFormPageProviderProps & { children?: React.ReactNode }) {
  // Features guard.
  const { featureCan } = useFeatureCan();
  const isBranchFeatureCan = featureCan(Features.Branches);

  const { data: currencies, isLoading: isCurrenciesLoading } = useCurrencies();

  // Fetches vendors list (the payee of an expense is a vendor).
  const { data: vendorsData, isLoading: isVendorsLoading } = useVendors({
    page_size: 10000,
  });

  // Fetch the expense details.
  const { data: expense, isLoading: isExpenseLoading } = useExpense(expenseId, {
    enabled: !!expenseId,
  });

  // Fetches the branches list.
  const {
    data: branches,
    isLoading: isBranchesLoading,
    isSuccess: isBranchesSuccess,
  } = useBranches(query, { enabled: isBranchFeatureCan });

  // Fetch accounts list.
  const { data: accounts, isLoading: isAccountsLoading } = useAccounts();

  // Fetch tax rates.
  const isSalesTaxFeatureCan = featureCan(Features.SalesTax);
  const { data: taxRates, isLoading: isTaxRatesLoading } = useTaxRates({
    enabled: isSalesTaxFeatureCan,
  });

  // Create and edit expense mutate.
  const { mutateAsync: createExpenseMutate } = useCreateExpense();
  const { mutateAsync: editExpenseMutate } = useEditExpense();

  // Expense settings.
  const { data: expenseSettings } = useSettingsExpenses();

  // Submit form payload - using ref for synchronous access.
  const submitPayloadRef = React.useRef<
    ExpenseFormContext['submitPayloadRef']['current']
  >({});

  // Setter to update the ref.
  const setSubmitPayload = React.useCallback(
    (payload: ExpenseFormContext['submitPayloadRef']['current']) => {
      submitPayloadRef.current = payload;
    },
    [],
  );

  // Detarmines whether the form in new mode.
  const isNewMode = !expenseId;

  // Provider payload.
  const provider: ExpenseFormContext = {
    isNewMode,
    expenseId,
    submitPayloadRef,

    currencies: currencies ?? [],
    vendors: vendorsData?.data ?? [],
    expense,
    accounts: accounts ?? [],
    branches: branches ?? [],
    taxRates: (taxRates as Record<string, any>[] | undefined) ?? [],

    isCurrenciesLoading,
    isExpenseLoading,
    isVendorsLoading,
    isAccountsLoading,
    isBranchesSuccess,
    isBranchesLoading,

    createExpenseMutate,
    editExpenseMutate,
    setSubmitPayload,

    expenseSettings,
  };

  return (
    <DashboardInsider
      loading={
        isCurrenciesLoading ||
        isExpenseLoading ||
        isVendorsLoading ||
        isAccountsLoading ||
        (isSalesTaxFeatureCan && isTaxRatesLoading)
      }
      name={'expense-form'}
      className={css`
        min-height: calc(100vh - var(--top-offset));
        max-height: calc(100vh - var(--top-offset));
      `}
    >
      <ExpenseFormPageContext.Provider value={provider} {...props} />
    </DashboardInsider>
  );
}

const useExpenseFormContext = (): ExpenseFormContext => {
  const ctx = React.useContext(ExpenseFormPageContext);
  if (!ctx) {
    throw new Error(
      'useExpenseFormContext must be used within an ExpenseFormPageProvider',
    );
  }
  return ctx;
};

export { ExpenseFormPageProvider, useExpenseFormContext };
