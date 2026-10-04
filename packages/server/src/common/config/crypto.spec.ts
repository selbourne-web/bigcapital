import cryptoConfig from './crypto';

describe('crypto config', () => {
  const saved = process.env.CRYPTO_SYNC_INTERVAL_MS;
  afterEach(() => {
    if (saved === undefined) delete process.env.CRYPTO_SYNC_INTERVAL_MS;
    else process.env.CRYPTO_SYNC_INTERVAL_MS = saved;
  });

  it('defaults the sync interval to 5 minutes', () => {
    delete process.env.CRYPTO_SYNC_INTERVAL_MS;
    expect(cryptoConfig().syncIntervalMs).toBe(300000);
  });

  it('honours CRYPTO_SYNC_INTERVAL_MS', () => {
    process.env.CRYPTO_SYNC_INTERVAL_MS = '60000';
    expect(cryptoConfig().syncIntervalMs).toBe(60000);
  });
});
