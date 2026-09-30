import { bankRulesMatchTransaction } from './_utils';

const withdrawal = (description: string) =>
  ({
    description,
    isDepositTransaction: false,
    isWithdrawalTransaction: true,
  }) as any;

const rule = (comparator: string, value: string) =>
  ({
    id: 1,
    applyIfTransactionType: 'withdrawal',
    conditionsType: 'and',
    conditions: [{ field: 'description', comparator, value }],
  }) as any;

describe('bankRulesMatchTransaction', () => {
  it('matches "contains" regardless of case', () => {
    expect(
      bankRulesMatchTransaction(withdrawal('AMAZON MKTP US'), [
        rule('contains', 'amazon'),
      ]),
    ).toBeDefined();
  });

  it('treats "not_contains" as the exact inverse of "contains", ignoring case', () => {
    expect(
      bankRulesMatchTransaction(withdrawal('AMAZON MKTP US'), [
        rule('not_contains', 'amazon'),
      ]),
    ).toBeUndefined();
    expect(
      bankRulesMatchTransaction(withdrawal('STARBUCKS #1234'), [
        rule('not_contains', 'amazon'),
      ]),
    ).toBeDefined();
  });

  it('treats a missing description as not containing the text', () => {
    expect(
      bankRulesMatchTransaction(withdrawal(undefined as any), [
        rule('not_contains', 'amazon'),
      ]),
    ).toBeDefined();
  });
});
