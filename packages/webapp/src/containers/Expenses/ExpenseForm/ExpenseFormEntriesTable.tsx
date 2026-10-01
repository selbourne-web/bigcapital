import * as FF from 'fp-ts/function';
import React, { useCallback } from 'react';
import { useExpenseFormTableColumns } from './components';
import { useExpenseFormContext } from './ExpenseFormPageProvider';
import type { ExpenseEntry } from './types';
import { DataTableEditable } from '@/components';
import {
  saveInvoke,
  updateTableCell,
  updateMinEntriesLines,
  updateAutoAddNewLine,
  updateRemoveLineByIndex,
} from '@/utils';

type ExpenseFormEntriesTableProps = {
  entries: ExpenseEntry[];
  defaultEntry: ExpenseEntry;
  error?: unknown;
  onChange: (entries: ExpenseEntry[]) => void;
  currencyCode: string;
  landedCost?: boolean;
  salesTax?: boolean;
  minLines?: number;
};

/**
 * Expenses form entries.
 */
export function ExpenseFormEntriesTable({
  entries,
  defaultEntry,
  error,
  onChange,
  currencyCode,
  landedCost = true,
  salesTax = false,
  minLines = 1,
}: ExpenseFormEntriesTableProps) {
  const { accounts, taxRates } = useExpenseFormContext();

  // Older expenses record their VAT as a line ticked "Tax"; keep that column
  // only where such a line exists so those expenses still read correctly.
  const hasLegacyTaxLines = entries.some((entry) => !!entry.isTax);

  const columns = useExpenseFormTableColumns({
    landedCost,
    salesTax,
    legacyTaxLine: hasLegacyTaxLines,
  });

  const handleUpdateData = useCallback(
    (rowIndex: number, columnId: string, value: unknown) => {
      const newRows = FF.pipe(
        entries,
        updateTableCell(rowIndex, columnId, value),
        updateAutoAddNewLine(defaultEntry, ['expenseAccountId']),
      );

      saveInvoke(onChange, newRows);
    },
    [entries, defaultEntry, onChange],
  );

  const handleRemoveRow = useCallback(
    (rowIndex: number) => {
      const newRows = FF.pipe(
        entries,
        updateRemoveLineByIndex(rowIndex),
        updateMinEntriesLines(minLines, defaultEntry),
      );

      saveInvoke(onChange, newRows);
    },
    [minLines, entries, defaultEntry, onChange],
  );

  return (
    <DataTableEditable
      name={'expense-form'}
      columns={columns}
      data={entries}
      sticky={true}
      payload={{
        accounts: accounts,
        taxRates,
        errors: error,
        updateData: handleUpdateData,
        removeRow: handleRemoveRow,
        autoFocus: ['expenseAccountId', 0],
        currencyCode,
      }}
    />
  );
}
