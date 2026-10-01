import { ExpenseGL } from './ExpenseGL';

const TAX_PAYABLE = 99;
const BANK = 10;

const receipt = (isInclusiveTax: boolean, amounts: number[]) =>
  ({
    id: 1,
    currencyCode: 'BBD',
    exchangeRate: 1,
    paymentDate: '2026-09-28',
    paymentAccountId: BANK,
    paymentAccount: { accountNormal: 'debit' },
    isInclusiveTax,
    totalAmount: 43.95,
    get localAmount() {
      return this.totalAmount * this.exchangeRate;
    },
    categories: amounts.map((amount, i) => ({
      amount,
      expenseAccountId: 100 + i,
      taxRateId: 1,
      taxRate: 17.5,
    })),
  }) as any;

const sum = (entries, key: 'debit' | 'credit') =>
  Math.round(entries.reduce((s, e) => s + (e[key] || 0), 0) * 100) / 100;

describe('ExpenseGL with tax', () => {
  it('posts net amounts to expenses and the VAT to tax payable, balanced', () => {
    const entries = new ExpenseGL(receipt(false, [22.25, 10.55, 4.6]))
      .setTaxPayableAccountId(TAX_PAYABLE)
      .getExpenseGLEntries();

    expect(sum(entries, 'debit')).toBe(43.95);
    expect(sum(entries, 'credit')).toBe(43.95);

    const taxEntries = entries.filter((e) => e.accountId === TAX_PAYABLE);
    expect(taxEntries).toHaveLength(1);
    expect(taxEntries[0]).toMatchObject({
      debit: 6.55,
      taxRateId: 1,
      taxRate: 17.5,
    });
    expect(
      entries.filter((e) => e.accountId >= 100).map((e) => e.debit),
    ).toEqual([22.25, 10.55, 4.6]);
  });

  it('backs the VAT out of inclusive amounts and stays balanced', () => {
    const entries = new ExpenseGL(receipt(true, [26.14, 12.4, 5.41]))
      .setTaxPayableAccountId(TAX_PAYABLE)
      .getExpenseGLEntries();

    expect(sum(entries, 'debit')).toBe(sum(entries, 'credit'));
    expect(sum(entries, 'credit')).toBe(43.95);
  });

  it('posts no tax entry for lines without a rate', () => {
    const expense = receipt(false, [37.4, 6.55]);
    expense.categories.forEach((c) => {
      c.taxRateId = null;
      c.taxRate = null;
    });
    const entries = new ExpenseGL(expense).getExpenseGLEntries();

    expect(entries.some((e) => e.taxRateId)).toBe(false);
    expect(sum(entries, 'debit')).toBe(43.95);
  });
});
