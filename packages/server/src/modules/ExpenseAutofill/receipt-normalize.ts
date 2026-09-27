import type {
  ExpenseAccountOption,
  RawReceiptExtraction,
  ReceiptAutofill,
} from './ReceiptExtraction.schema';

const round2 = (value: number) => Math.round(value * 100) / 100;

const cleanText = (value: string | null, max: number): string | null => {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
};

/** A real calendar date as YYYY-MM-DD, otherwise null. */
export const cleanDate = (value: string | null): string | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((value ?? '').trim());
  if (!match) return null;

  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;

  return valid ? match[0] : null;
};

/**
 * Turns the model's answer into what the expense form takes. The answer is
 * treated as untrusted: text is trimmed and capped, amounts are rounded, and an
 * account id only survives if it is one of the accounts that were offered.
 * @param {RawReceiptExtraction} raw - The validated answer.
 * @param {ExpenseAccountOption[]} accounts - The accounts that were offered.
 * @returns {ReceiptAutofill}
 */
export const normalizeReceipt = (
  raw: RawReceiptExtraction,
  accounts: ExpenseAccountOption[],
): ReceiptAutofill => {
  const offered = new Set(accounts.map((account) => account.id));
  const warnings: string[] = [];

  const payee = cleanText(raw.payee, 200);
  const total = raw.total == null ? null : round2(raw.total);
  const taxTotal = raw.tax_total == null ? null : round2(raw.tax_total);

  const lines: ReceiptAutofill['lines'] = raw.lines
    .filter((line) => line.amount !== 0)
    .slice(0, 50)
    .map((line) => ({
      description: cleanText(line.description, 300) ?? '',
      amount: round2(line.amount),
      accountId:
        line.account_id != null && offered.has(line.account_id)
          ? line.account_id
          : null,
      isTax: false,
    }));

  // A receipt with only a total still gives one line to start from.
  if (!lines.length && total != null && total !== 0) {
    lines.push({
      description: payee ?? 'Expense',
      amount: total,
      accountId: null,
      isTax: false,
    });
  }

  // Tax shown on top of the lines becomes a line of its own, so the lines add
  // up to the total on the receipt (the expense form has no tax column).
  if (!raw.amounts_include_tax && taxTotal != null && taxTotal > 0) {
    const carrier = lines.find((line) => line.accountId != null);
    lines.push({
      description: 'Tax',
      amount: taxTotal,
      accountId: carrier?.accountId ?? null,
      isTax: true,
    });
  }

  const linesTotal = round2(lines.reduce((sum, line) => sum + line.amount, 0));
  if (total != null && Math.abs(linesTotal - total) > 0.01) {
    warnings.push(
      `The lines add up to ${linesTotal.toFixed(2)} but the document total reads ${total.toFixed(2)}. Please check the amounts.`,
    );
  }
  if (!lines.length) {
    warnings.push('No line items could be read from this document.');
  }

  const currency = (raw.currency_code ?? '').trim().toUpperCase();

  return {
    payee,
    date: cleanDate(raw.date),
    referenceNo: cleanText(raw.reference_no, 100),
    currencyCode: /^[A-Z]{3}$/.test(currency) ? currency : null,
    memo: cleanText(raw.memo, 500),
    lines,
    total,
    warnings,
  };
};
