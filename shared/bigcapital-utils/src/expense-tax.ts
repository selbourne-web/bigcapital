
export interface ExpenseTaxLineInput {
  amount?: number;
  taxRateId?: number | null;
  taxRate?: number | null;
}

export interface ExpenseTaxLine {
  /** The amount that goes to the line's expense account (tax excluded). */
  netAmount: number;
  /** This line's share of its rate's tax. */
  taxAmount: number;
}

export interface ExpenseTaxGroup {
  taxRateId: number;
  taxRate: number;
  /** The amount the tax is calculated on (tax excluded). */
  taxableAmount: number;
  taxAmount: number;
}

export interface ExpenseTaxSummary {
  lines: ExpenseTaxLine[];
  groups: ExpenseTaxGroup[];
  /** Total of the lines, tax excluded. */
  subtotal: number;
  taxTotal: number;
  /** What was paid, tax included. */
  total: number;
}

const round2 = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;

/** Tax contained in an amount that already includes it. */
const getInclusiveTaxAmount = (amount: number, taxRate: number) =>
  (amount * taxRate) / (100 + taxRate);

/** Tax charged on top of an amount that excludes it. */
const getExlusiveTaxAmount = (amount: number, taxRate: number) =>
  (amount * taxRate) / 100;

/**
 * Works out an expense's tax the way a receipt does: once per tax rate on the
 * subtotal of that rate's lines, rounded to the cent, rather than rounding
 * each line (which can drift a cent from the printed total). Each line still
 * gets its share so the ledger debits balance the payment credit exactly.
 * Lines without a rate carry no tax.
 */
export const computeExpenseTax = (
  lines: ExpenseTaxLineInput[],
  isInclusiveTax: boolean,
): ExpenseTaxSummary => {
  const result: ExpenseTaxLine[] = lines.map((line) => ({
    netAmount: round2(line.amount || 0),
    taxAmount: 0,
  }));
  const groups: ExpenseTaxGroup[] = [];

  const byRate = new Map<number, number[]>();
  lines.forEach((line, index) => {
    if (line.taxRateId && line.taxRate && line.taxRate > 0) {
      const indexes = byRate.get(line.taxRateId) ?? [];
      byRate.set(line.taxRateId, [...indexes, index]);
    }
  });

  byRate.forEach((indexes, taxRateId) => {
    const taxRate = lines[indexes[0]].taxRate as number;
    const groupAmount = indexes.reduce(
      (sum, i) => sum + (lines[i].amount || 0),
      0,
    );
    const groupTax = round2(
      isInclusiveTax
        ? getInclusiveTaxAmount(groupAmount, taxRate)
        : getExlusiveTaxAmount(groupAmount, taxRate),
    );

    // Share the group's tax across its lines; the last line takes the
    // rounding remainder so the shares add up to the group tax exactly.
    let allocated = 0;
    indexes.forEach((i, position) => {
      const isLast = position === indexes.length - 1;
      const share = isLast
        ? round2(groupTax - allocated)
        : round2(
            groupAmount ? ((lines[i].amount || 0) / groupAmount) * groupTax : 0,
          );
      allocated = round2(allocated + share);
      result[i].taxAmount = share;
      if (isInclusiveTax) {
        result[i].netAmount = round2((lines[i].amount || 0) - share);
      }
    });

    groups.push({
      taxRateId,
      taxRate,
      taxableAmount: round2(
        isInclusiveTax ? groupAmount - groupTax : groupAmount,
      ),
      taxAmount: groupTax,
    });
  });

  const subtotal = round2(result.reduce((sum, l) => sum + l.netAmount, 0));
  const taxTotal = round2(groups.reduce((sum, g) => sum + g.taxAmount, 0));

  return {
    lines: result,
    groups,
    subtotal,
    taxTotal,
    total: round2(subtotal + taxTotal),
  };
};
