import { formatNumber } from './format-number';

interface AmountDocument {
  amount?: number | string | null;
  currencyCode?: string;
  formattedAmount?: string;
}

/**
 * The document amount with its currency symbol, for the mail message text. The
 * `formattedAmount` the transformers produce carries no currency symbol.
 * Falls back to `formattedAmount` when the raw amount is not available.
 * @param {AmountDocument} document
 * @returns {string}
 */
export const formatMailAmount = (document: AmountDocument): string => {
  if (document.amount == null || document.amount === '') {
    return document.formattedAmount;
  }
  return formatNumber(document.amount, {
    currencyCode: document.currencyCode,
    money: true,
  });
};
