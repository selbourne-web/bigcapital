import { Transformer } from '@/modules/Transformer/Transformer';
import { ExpenseCategoryTransformer } from './ExpenseCategory.transformer';
// import { AttachmentTransformer } from '@/services/Attachments/AttachmentTransformer';
import { Expense } from '../models/Expense.model';
import { AttachmentTransformer } from '@/modules/Attachments/Attachment.transformer';
import { computeExpenseTax } from '@bigcapital/utils';

export class ExpenseTransfromer extends Transformer {
  /**
   * Include these attributes to expense object.
   * @returns {Array}
   */
  public includeAttributes = (): string[] => {
    return [
      'formattedAmount',
      'formattedLandedCostAmount',
      'formattedAllocatedCostAmount',
      'payeeName',
      'salesTaxAmount',
      'formattedSalesTaxAmount',
      'formattedAmountBeforeSalesTax',
      'taxes',
      'formattedDate',
      'formattedCreatedAt',
      'formattedPublishedAt',
      'categories',
      'attachments',
      'branch',
    ];
  };

  /**
   * Retrieve formatted expense amount.
   * @param {Expense} expense - Expense.
   * @returns {string}
   */
  protected formattedAmount = (expense: Expense): string => {
    return this.formatNumber(expense.totalAmount, {
      currencyCode: expense.currencyCode,
    });
  };

  /**
   * The name of the vendor the expense was paid to.
   * @param {Expense} expense - Expense.
   * @returns {string | null}
   */
  protected payeeName = (expense: Expense): string | null => {
    return expense.payee?.displayName ?? null;
  };

  /**
   * The expense's tax worked out from the lines' tax rates.
   * @param {Expense} expense - Expense.
   */
  private getTax = (expense: Expense) =>
    computeExpenseTax(
      (expense.categories ?? []).map((category) => ({
        amount: Number(category.amount || 0),
        taxRateId: category.taxRateId,
        taxRate: category.taxRate ? Number(category.taxRate) : null,
      })),
      !!expense.isInclusiveTax,
    );

  /**
   * The sales tax of the expense: tax from the lines' tax rates, plus any
   * line recorded the older way, as its own line marked as tax.
   * @param {Expense} expense - Expense.
   * @returns {number}
   */
  protected salesTaxAmount = (expense: Expense): number => {
    const taxLinesAmount = (expense.categories ?? [])
      .filter((category) => category.isTax)
      .reduce((sum, category) => sum + Number(category.amount || 0), 0);

    return taxLinesAmount + this.getTax(expense).taxTotal;
  };

  /**
   * The tax per tax rate, e.g. "17.5% on 37.40 = 6.55".
   * @param {Expense} expense - Expense.
   */
  protected taxes = (expense: Expense) => {
    return this.getTax(expense).groups.map((group) => ({
      ...group,
      formattedTaxableAmount: this.formatNumber(group.taxableAmount, {
        currencyCode: expense.currencyCode,
      }),
      formattedTaxAmount: this.formatNumber(group.taxAmount, {
        currencyCode: expense.currencyCode,
      }),
    }));
  };

  /**
   * Formatted sales tax of the expense.
   * @param {Expense} expense - Expense.
   * @returns {string}
   */
  protected formattedSalesTaxAmount = (expense: Expense): string => {
    return this.formatNumber(this.salesTaxAmount(expense), {
      currencyCode: expense.currencyCode,
    });
  };

  /**
   * Formatted total before the sales tax.
   * @param {Expense} expense - Expense.
   * @returns {string}
   */
  protected formattedAmountBeforeSalesTax = (expense: Expense): string => {
    return this.formatNumber(
      Number(expense.totalAmount || 0) - this.salesTaxAmount(expense),
      { currencyCode: expense.currencyCode },
    );
  };

  /**
   * Retrieve formatted expense landed cost amount.
   * @param {Expense} expense - Expense.
   * @returns {string}
   */
  protected formattedLandedCostAmount = (expense: Expense): string => {
    return this.formatNumber(expense.landedCostAmount, {
      currencyCode: expense.currencyCode,
    });
  };

  /**
   * Retrieve formatted allocated cost amount.
   * @param {Expense} expense - Expense.
   * @returns {string}
   */
  protected formattedAllocatedCostAmount = (expense: Expense): string => {
    return this.formatNumber(expense.allocatedCostAmount, {
      currencyCode: expense.currencyCode,
    });
  };

  /**
   * Retriecve fromatted date.
   * @param {Expense} expense - Expense.
   * @returns {string}
   */
  protected formattedDate = (expense: Expense): string => {
    return this.formatDate(expense.paymentDate);
  };

  /**
   * Retrieve formatted created at date.
   * @param {Expense} expense - Expense.
   * @returns {string}
   */
  protected formattedCreatedAt = (expense: Expense): string => {
    return this.formatDate(expense.createdAt);
  };

  /**
   * Retrieves the transformed expense categories.
   * @param {Expense} expense - Expense.
   * @returns
   */
  protected categories = (expense: Expense) => {
    return this.item(expense.categories, new ExpenseCategoryTransformer(), {
      currencyCode: expense.currencyCode,
    });
  };

  /**
   * Retrieves the sale invoice attachments.
   * @param {Expense} expense - Expense.
   * @returns
   */
  protected attachments = (expense: Expense) => {
    return this.item(expense.attachments, new AttachmentTransformer());
  };

  /**
   * Retrieve formatted published at date.
   * @param {Expense} expense - Expense.
   * @returns {string}
   */
  protected formattedPublishedAt = (expense: Expense): string => {
    return this.formatDate(expense.publishedAt);
  };
}
