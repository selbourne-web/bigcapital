import {
  CRYPTO_RECORD_TYPES,
  CSV_LIMITS,
  CRYPTO_SYNC_PIONEX_QUEUE,
  CRYPTO_SYNC_QUEUE_NAMES,
  SUPPORTED_CRYPTO_EXCHANGES,
  queueNameFor,
} from './CryptoExchanges.constants';

describe('crypto exchange constants (pieces 2a, 2b)', () => {
  it('maps the Crypto.com exchanges to their own sync queues', () => {
    expect(queueNameFor('crypto_com')).toBe('crypto-sync-crypto_com');
    expect(queueNameFor('crypto_com_app')).toBe('crypto-sync-crypto_com_app');
  });

  it('maps Pionex to its own sync queue', () => {
    expect(queueNameFor('pionex')).toBe('crypto-sync-pionex');
    expect(CRYPTO_SYNC_PIONEX_QUEUE).toBe('crypto-sync-pionex');
  });

  it('supports both Crypto.com exchanges Pionex and registers five queues', () => {
    expect(SUPPORTED_CRYPTO_EXCHANGES).toEqual(
      expect.arrayContaining([
        'kraken',
        'binance',
        'crypto_com',
        'crypto_com_app',
        'pionex',
      ]),
    );
    expect(CRYPTO_SYNC_QUEUE_NAMES).toEqual([
      'crypto-sync-kraken',
      'crypto-sync-binance',
      'crypto-sync-crypto_com',
      'crypto-sync-crypto_com_app',
      'crypto-sync-pionex',
    ]);
  });

  it('still has no queue for CSV-only exchanges', () => {
    expect(() => queueNameFor('nexo')).toThrow(/nexo/);
  });

  it('knows the CSV-era record types and keeps every type within varchar(16)', () => {
    expect(CRYPTO_RECORD_TYPES).toEqual(
      expect.arrayContaining([
        'trade',
        'deposit',
        'withdrawal',
        'fee',
        'reward',
        'unparsed',
        'trade_summary',
        'funding',
        'adjustment',
        'position',
      ]),
    );
    for (const t of CRYPTO_RECORD_TYPES) {
      expect(t.length).toBeLessThanOrEqual(16);
    }
  });

  it('bounds untrusted CSV input', () => {
    expect(CSV_LIMITS).toEqual({
      maxBytes: 10 * 1024 * 1024,
      maxRows: 200_000,
      maxCellChars: 2_000,
      maxFilenameChars: 255,
    });
  });
});
