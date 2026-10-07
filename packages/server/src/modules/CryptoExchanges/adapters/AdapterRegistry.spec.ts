import { AdapterRegistry } from './AdapterRegistry';
import { KrakenAdapter } from './kraken/KrakenAdapter';
import { BinanceAdapter } from './binance/BinanceAdapter';
import { CryptoComAdapter } from './cryptocom/CryptoComAdapter';
import { CryptoComAppAdapter } from './cryptocomapp/CryptoComAppAdapter';
import { PionexAdapter } from './pionex/PionexAdapter';

describe('AdapterRegistry', () => {
  const registry = new AdapterRegistry();

  it('returns the Kraken and Binance adapters', () => {
    expect(registry.get('kraken')).toBeInstanceOf(KrakenAdapter);
    expect(registry.get('binance')).toBeInstanceOf(BinanceAdapter);
    expect(registry.get('kraken').id).toBe('kraken');
    expect(registry.get('binance').id).toBe('binance');
  });

  it('returns the Crypto.com Exchange adapter', () => {
    expect(registry.get('crypto_com')).toBeInstanceOf(CryptoComAdapter);
    expect(registry.get('crypto_com').id).toBe('crypto_com');
  });

  it('returns the Crypto.com App adapter', () => {
    expect(registry.get('crypto_com_app')).toBeInstanceOf(CryptoComAppAdapter);
    expect(registry.get('crypto_com_app').id).toBe('crypto_com_app');
  });

  // The sync service acquires `historyPageCost` tokens per history page and the rate
  // limiter throws when a cost can never be satisfied (cost > capacity).
  it('returns the Pionex adapter', () => {
    expect(registry.get('pionex')).toBeInstanceOf(PionexAdapter);
    expect(registry.get('pionex').id).toBe('pionex');
  });

  it.each([
    'kraken',
    'binance',
    'crypto_com',
    'crypto_com_app',
    'pionex',
  ] as const)('%s: every token cost fits its bucket capacity', (id) => {
    const { capacity, refillPerSec, historyPageCost } =
      registry.get(id).rateLimit;
    expect(capacity).toBeGreaterThan(0);
    expect(refillPerSec).toBeGreaterThan(0);
    expect(historyPageCost ?? 1).toBeLessThanOrEqual(capacity);
    expect(1).toBeLessThanOrEqual(capacity); // balance / inspect calls cost 1
  });

  it('throws for unsupported exchange nexo', () => {
    expect(() => registry.get('nexo')).toThrow('Unsupported exchange: nexo');
  });
});
