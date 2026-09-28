import {
  consumeRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCodes,
} from './recovery-codes';

describe('recovery-codes', () => {
  it('generates 8 unique, formatted codes by default', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    codes.forEach((code) => expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/));
  });

  it('consumes a matching code and removes only that one', async () => {
    const codes = generateRecoveryCodes();
    const hashes = await hashRecoveryCodes(codes);

    const { matched, remaining } = await consumeRecoveryCode(codes[3], hashes);

    expect(matched).toBe(true);
    expect(remaining).toHaveLength(hashes.length - 1);
  });

  it('is single-use: the same code does not match again', async () => {
    const codes = generateRecoveryCodes();
    const hashes = await hashRecoveryCodes(codes);

    const first = await consumeRecoveryCode(codes[0], hashes);
    const second = await consumeRecoveryCode(codes[0], first.remaining);

    expect(second.matched).toBe(false);
    expect(second.remaining).toEqual(first.remaining);
  });

  it('rejects an unknown code without changing the stored list', async () => {
    const codes = generateRecoveryCodes();
    const hashes = await hashRecoveryCodes(codes);

    const { matched, remaining } = await consumeRecoveryCode(
      'ZZZZ-9999',
      hashes,
    );

    expect(matched).toBe(false);
    expect(remaining).toEqual(hashes);
  });

  it('is not case- or whitespace-sensitive', async () => {
    const codes = generateRecoveryCodes();
    const hashes = await hashRecoveryCodes(codes);

    const { matched } = await consumeRecoveryCode(
      `  ${codes[0].toLowerCase()}  `,
      hashes,
    );
    expect(matched).toBe(true);
  });
});
