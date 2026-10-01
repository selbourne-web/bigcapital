import { Knex } from 'knex';
import { ExpenseGL } from './ExpenseGL';
import { Inject, Injectable } from '@nestjs/common';
import { Expense } from '../models/Expense.model';
import { ILedger } from '@/modules/Ledger/types/Ledger.types';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { AccountRepository } from '@/modules/Accounts/repositories/Account.repository';

@Injectable()
export class ExpenseGLEntriesService {
  /**
   * @param {TenantModelProxy<typeof Expense>} expense - Expense model.
   */
  constructor(
    @Inject(Expense.name)
    private readonly expense: TenantModelProxy<typeof Expense>,
    private readonly accountRepository: AccountRepository,
  ) {}

  /**
   * Retrieves the expense G/L of the given id.
   * @param {number} expenseId
   * @param {Knex.Transaction} trx - Knex transaction.
   * @returns {Promise<ILedger>}
   */
  public getExpenseLedgerById = async (
    expenseId: number,
    trx?: Knex.Transaction,
  ): Promise<ILedger> => {
    const expense = await this.expense()
      .query(trx)
      .findById(expenseId)
      .withGraphFetched('categories')
      .withGraphFetched('paymentAccount')
      .throwIfNotFound();

    // Only resolve (or create) the tax payable account when there is tax to
    // post, so expenses without tax never touch it.
    const hasTax = (expense.categories || []).some(
      (category) => category.taxRateId && category.taxRate,
    );
    const taxPayableAccount = hasTax
      ? await this.accountRepository.findOrCreateTaxPayable({}, trx)
      : null;

    return this.getExpenseLedger(expense, taxPayableAccount?.id);
  };

  /**
   * Retrieves the given expense ledger.
   * @param {Expense} expense - Expense model.
   * @param {number} taxPayableAccountId - Account the input tax is posted to.
   * @returns {ILedger}
   */
  public getExpenseLedger = (
    expense: Expense,
    taxPayableAccountId?: number,
  ): ILedger => {
    const expenseGL = new ExpenseGL(expense);

    if (taxPayableAccountId) {
      expenseGL.setTaxPayableAccountId(taxPayableAccountId);
    }
    return expenseGL.getExpenseLedger();
  };
}
