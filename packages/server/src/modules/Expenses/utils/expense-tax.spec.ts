import { computeExpenseTax } from '@bigcapital/utils';

const VAT = { taxRateId: 1, taxRate: 17.5 };

describe('computeExpenseTax', () => {
  it('matches a printed receipt: VAT once on the subtotal, not per line', () => {
    // Carter & Co receipt F85005/2: 22.25 + 10.55 + 4.60 = 37.40, VAT 6.55.
    const result = computeExpenseTax(
      [
        { amount: 22.25, ...VAT },
        { amount: 10.55, ...VAT },
        { amount: 4.6, ...VAT },
      ],
      false,
    );
    expect(result.subtotal).toBe(37.4);
    expect(result.taxTotal).toBe(6.55);
    expect(result.total).toBe(43.95);
    expect(result.groups).toEqual([
      { taxRateId: 1, taxRate: 17.5, taxableAmount: 37.4, taxAmount: 6.55 },
    ]);
    // Exclusive: the lines keep their amounts; shares add up to the VAT.
    expect(result.lines.map((l) => l.netAmount)).toEqual([22.25, 10.55, 4.6]);
    const shares = result.lines.reduce((s, l) => s + l.taxAmount, 0);
    expect(Math.round(shares * 100) / 100).toBe(6.55);
  });

  it('backs tax out of inclusive amounts and still balances to the total', () => {
    const result = computeExpenseTax(
      [
        { amount: 26.14, ...VAT },
        { amount: 12.4, ...VAT },
        { amount: 5.41, ...VAT },
      ],
      true,
    );
    expect(result.total).toBe(43.95);
    const debits = result.lines.reduce(
      (s, l) => s + l.netAmount + l.taxAmount,
      0,
    );
    expect(Math.round(debits * 100) / 100).toBe(43.95);
    expect(result.subtotal + result.taxTotal).toBeCloseTo(43.95, 2);
  });

  it('leaves lines without a rate (and old "Tax" lines) untaxed', () => {
    const result = computeExpenseTax(
      [{ amount: 37.4 }, { amount: 6.55 }],
      false,
    );
    expect(result.taxTotal).toBe(0);
    expect(result.total).toBe(43.95);
    expect(result.groups).toEqual([]);
  });

  it('calculates each rate separately', () => {
    const result = computeExpenseTax(
      [
        { amount: 100, ...VAT },
        { amount: 100, taxRateId: 2, taxRate: 0 },
        { amount: 50, taxRateId: 3, taxRate: 10 },
      ],
      false,
    );
    expect(result.taxTotal).toBe(22.5);
    expect(result.groups.map((g) => g.taxRateId)).toEqual([1, 3]);
  });
});
