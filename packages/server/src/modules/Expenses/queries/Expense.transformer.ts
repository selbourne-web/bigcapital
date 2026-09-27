import { Transformer } from '@/modules/Transformer/Transformer';
import { ExpenseCategoryTransformer } from './ExpenseCategory.transformer';
// import { AttachmentTransformer } from '@/services/Attachments/AttachmentTransformer';
import { Expense } from '../models/Expense.model';
import { AttachmentTransformer } from '@/modules/Attachments/Attachment.transformer';

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
   * The sales tax of the expense: the sum of the lines marked as tax.
   * @param {Expense} expense - Expense.
   * @returns {number}
   */
  protected salesTaxAmount = (expense: Expense): number => {
    return (expense.categories ?? [])
      .filter((category) => category.isTax)
      .reduce((sum, category) => sum + Number(category.amount || 0), 0);
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
