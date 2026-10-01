import * as R from 'ramda';
import { ILedger } from '@/modules/Ledger/types/Ledger.types';
import { AccountNormal } from '@/modules/Accounts/Accounts.types';
import { ILedgerEntry } from '@/modules/Ledger/types/Ledger.types';
import { ExpenseCategory } from '../models/ExpenseCategory.model';
import { Ledger } from '@/modules/Ledger/Ledger';
import { Expense } from '../models/Expense.model';
import { computeExpenseTax, ExpenseTaxSummary } from '@bigcapital/utils';

export class ExpenseGL {
  private expense: Expense;
  private taxPayableAccountId: number | null = null;
  private tax: ExpenseTaxSummary;

  /**
   * Constructor method.
   * @param {Expense} expense - Expense.
   */
  constructor(expense: Expense) {
    this.expense = expense;
    this.tax = computeExpenseTax(
      expense.categories || [],
      !!expense.isInclusiveTax,
    );
  }

  /**
   * Sets the account the expense's input tax is posted to.
   * @param {number} taxPayableAccountId
   */
  public setTaxPayableAccountId(taxPayableAccountId: number) {
    this.taxPayableAccountId = taxPayableAccountId;
    return this;
  }

  /**
   * Retrieves the expense GL common entry.
   */
  private getExpenseGLCommonEntry = () => {
    return {
      currencyCode: this.expense.currencyCode,
      exchangeRate: this.expense.exchangeRate,

      transactionType: 'Expense',
      transactionId: this.expense.id,

      date: this.expense.paymentDate,
      userId: this.expense.userId,

      debit: 0,
      credit: 0,

      branchId: this.expense.branchId,
    };
  };

  /**
   * Retrieves the expense GL payment entry.
   * @returns {ILedgerEntry}
   */
  private getExpenseGLPaymentEntry = (): ILedgerEntry => {
    const commonEntry = this.getExpenseGLCommonEntry();

    return {
      ...commonEntry,
      credit: this.expense.localAmount,
      accountId: this.expense.paymentAccountId,
      accountNormal:
        this.expense?.paymentAccount?.accountNormal === 'debit'
          ? AccountNormal.DEBIT
          : AccountNormal.CREDIT,
      index: 1,
    };
  };

  /**
   * Retrieves the expense GL category entry.
   * @param {ExpenseCategory} category - Expense category.
   * @param {number} index
   * @returns {ILedgerEntry}
   */
  private getExpenseGLCategoryEntry = R.curry(
    (category: ExpenseCategory, index: number): ILedgerEntry => {
      const commonEntry = this.getExpenseGLCommonEntry();
      // The expense account gets the amount tax excluded; the tax is posted
      // to the tax payable account separately.
      const netAmount = this.tax.lines[index]?.netAmount ?? category.amount;
      const localAmount = netAmount * this.expense.exchangeRate;

      return {
        ...commonEntry,
        accountId: category.expenseAccountId,
        accountNormal: AccountNormal.DEBIT,
        debit: localAmount,
        note: category.description,
        index: index + 2,
        projectId: category.projectId,
      };
    },
  );

  /**
   * Retrieves the input tax entries, one per tax rate, debited to the tax
   * payable account and tagged with the rate so tax reports pick them up.
   * @returns {ILedgerEntry[]}
   */
  private getExpenseGLTaxEntries = (): ILedgerEntry[] => {
    const taxGroups = this.tax.groups.filter((group) => group.taxAmount > 0);

    if (taxGroups.length > 0 && !this.taxPayableAccountId) {
      throw new Error('The tax payable account is required to post tax.');
    }
    const commonEntry = this.getExpenseGLCommonEntry();
    const lastLineIndex = this.expense.categories.length + 1;

    return taxGroups.map((group, index) => ({
      ...commonEntry,
      accountId: this.taxPayableAccountId as number,
      accountNormal: AccountNormal.CREDIT,
      debit: group.taxAmount * this.expense.exchangeRate,
      taxRateId: group.taxRateId,
      taxRate: group.taxRate,
      index: lastLineIndex + index + 1,
      indexGroup: 30,
    }));
  };

  /**
   * Retrieves the expense GL entries.
   * @returns {ILedgerEntry[]}
   */
  public getExpenseGLEntries = (): ILedgerEntry[] => {
    const getCategoryEntry = this.getExpenseGLCategoryEntry();

    const paymentEntry = this.getExpenseGLPaymentEntry();
    const categoryEntries = this.expense.categories.map((category, index) =>
      getCategoryEntry(category, index),
    );
    return [paymentEntry, ...categoryEntries, ...this.getExpenseGLTaxEntries()];
  };

  /**
   * Retrieves the given expense ledger.
   * @returns {ILedger}
   */
  public getExpenseLedger = (): ILedger => {
    const entries = this.getExpenseGLEntries();

    return new Ledger(entries);
  };
}
