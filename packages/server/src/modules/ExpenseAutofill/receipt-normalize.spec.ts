import { cleanDate, normalizeReceipt } from './receipt-normalize';
import type { RawReceiptExtraction } from './ReceiptExtraction.schema';

const accounts = [
  { id: 10, name: 'Shipping and delivery expense' },
  { id: 20, name: 'Office supplies' },
];

const raw = (
  over: Partial<RawReceiptExtraction> = {},
): RawReceiptExtraction => ({
  payee: 'CargoBGI',
  date: '2026-09-24',
  reference_no: 'FF26079/582186',
  currency_code: 'bbd',
  memo: null,
  amounts_include_tax: false,
  lines: [
    {
      description: 'Freight - Minimum Rate in Lbs',
      amount: 24,
      account_id: 10,
    },
    { description: 'Package Processing Fee', amount: 8.51, account_id: 10 },
    { description: 'Insurance', amount: 3, account_id: 10 },
  ],
  tax_total: 1.49,
  total: 37,
  ...over,
});

describe('normalizeReceipt', () => {
  it('reads a bill like the QuickBooks example: lines plus tax that add up to the total', () => {
    const result = normalizeReceipt(raw(), accounts);

    expect(result.payee).toBe('CargoBGI');
    expect(result.date).toBe('2026-09-24');
    expect(result.referenceNo).toBe('FF26079/582186');
    expect(result.currencyCode).toBe('BBD');
    expect(result.lines.map((line) => line.amount)).toEqual([
      24, 8.51, 3, 1.49,
    ]);
    expect(result.lines[3]).toMatchObject({
      description: 'Tax',
      isTax: true,
      accountId: 10,
    });
    expect(result.warnings).toEqual([]);
  });

  it('does not add a tax line when the amounts already include tax', () => {
    const result = normalizeReceipt(
      raw({ amounts_include_tax: true, total: 35.51 }),
      accounts,
    );
    expect(result.lines.some((line) => line.isTax)).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('warns when the lines do not add up to the total', () => {
    const result = normalizeReceipt(raw({ total: 50 }), accounts);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('37.00');
    expect(result.warnings[0]).toContain('50.00');
  });

  it('drops account ids that were not offered (a model can make one up)', () => {
    const result = normalizeReceipt(
      raw({
        lines: [{ description: 'x', amount: 5, account_id: 999 }],
        tax_total: null,
        total: 5,
      }),
      accounts,
    );
    expect(result.lines[0].accountId).toBeNull();
  });

  it('gives a total-only receipt one line to start from', () => {
    const result = normalizeReceipt(
      raw({ lines: [], tax_total: null, total: 12.5 }),
      accounts,
    );
    expect(result.lines).toEqual([
      { description: 'CargoBGI', amount: 12.5, accountId: null, isTax: false },
    ]);
  });

  it('keeps discounts as negative lines and skips zero lines', () => {
    const result = normalizeReceipt(
      raw({
        lines: [
          { description: 'Item', amount: 20, account_id: 20 },
          { description: 'Discount', amount: -5, account_id: 20 },
          { description: 'Free sample', amount: 0, account_id: null },
        ],
        tax_total: null,
        total: 15,
      }),
      accounts,
    );
    expect(result.lines.map((line) => line.amount)).toEqual([20, -5]);
    expect(result.warnings).toEqual([]);
  });

  it('cleans text and refuses a made-up date or currency', () => {
    const result = normalizeReceipt(
      raw({
        payee: '  Acme \n  Ltd  ',
        date: '2026-02-31',
        currency_code: 'dollars',
        reference_no: 'x'.repeat(500),
      }),
      accounts,
    );
    expect(result.payee).toBe('Acme Ltd');
    expect(result.date).toBeNull();
    expect(result.currencyCode).toBeNull();
    expect(result.referenceNo).toHaveLength(100);
  });

  it('reports a document with nothing readable', () => {
    const result = normalizeReceipt(
      raw({ lines: [], tax_total: null, total: null, payee: null }),
      accounts,
    );
    expect(result.lines).toEqual([]);
    expect(result.warnings).toContain(
      'No line items could be read from this document.',
    );
  });
});

describe('cleanDate', () => {
  it('accepts real dates only', () => {
    expect(cleanDate('2026-09-24')).toBe('2026-09-24');
    expect(cleanDate('2024-02-29')).toBe('2024-02-29');
    expect(cleanDate('2026-02-29')).toBeNull();
    expect(cleanDate('24/09/2026')).toBeNull();
    expect(cleanDate(null)).toBeNull();
  });
});
