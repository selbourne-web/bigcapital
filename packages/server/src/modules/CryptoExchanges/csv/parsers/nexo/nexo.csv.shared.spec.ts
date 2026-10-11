import { CRYPTO_RECORD_TYPES } from '../../../CryptoExchanges.constants';
import {
  isNexoDecimal,
  isNexoUsd,
  nexoCell,
  parseEpochMs,
  parseNexoUtc,
} from './nexo.csv.shared';

describe('nexo value helpers', () => {
  it('parseNexoUtc reads strict UTC timestamps', () => {
    expect(parseNexoUtc('2026-01-31 23:59:59')).toEqual(
      new Date(Date.UTC(2026, 0, 31, 23, 59, 59)),
    );
    for (const bad of [
      '2026-02-30 00:00:00',
      '2026-01-31T23:59:59Z',
      '31/01/2026',
      '',
    ]) {
      expect(parseNexoUtc(bad)).toBeNull();
    }
  });

  it('parseEpochMs reads 13-digit epoch milliseconds in range', () => {
    expect(parseEpochMs('1767225600000')).toEqual(new Date(1767225600000));
    for (const bad of [
      '1767225600',
      'abc',
      '99999999999999',
      '1000000000000',
    ]) {
      expect(parseEpochMs(bad)).toBeNull();
    }
  });

  it('nexoCell maps blank tokens to null', () => {
    for (const blank of [' - ', 'null', 'NULL', '', undefined]) {
      expect(nexoCell(blank)).toBeNull();
    }
    expect(nexoCell('0')).toBe('0');
    expect(nexoCell(' xUSD ')).toBe('xUSD');
  });

  it('isNexoDecimal accepts plain signed decimals only', () => {
    for (const ok of ['0', '-0.00000001', '12.5']) {
      expect(isNexoDecimal(ok)).toBe(true);
    }
    for (const bad of ['1,000.5', '1e-8', '$5', '.5', '', '1.1234567890123']) {
      expect(isNexoDecimal(bad)).toBe(false);
    }
  });

  it('isNexoUsd accepts a dollar sign and a non-negative decimal', () => {
    for (const ok of ['$0.00', '$123.45', '$7']) {
      expect(isNexoUsd(ok)).toBe(true);
    }
    for (const bad of ['123.45', '-$5.00', '$1,000.00', '$-5', '$']) {
      expect(isNexoUsd(bad)).toBe(false);
    }
  });

  it('record types include transfer and credit', () => {
    expect(CRYPTO_RECORD_TYPES).toEqual(
      expect.arrayContaining(['transfer', 'credit']),
    );
  });
});
