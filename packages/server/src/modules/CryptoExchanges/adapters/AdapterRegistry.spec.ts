import { AdapterRegistry } from './AdapterRegistry';
import { KrakenAdapter } from './kraken/KrakenAdapter';
import { BinanceAdapter } from './binance/BinanceAdapter';
import { CryptoComAdapter } from './cryptocom/CryptoComAdapter';
import { CryptoComAppAdapter } from './cryptocomapp/CryptoComAppAdapter';

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
  it.each(['kraken', 'binance', 'crypto_com', 'crypto_com_app'] as const)(
    '%s: every token cost fits its bucket capacity',
    (id) => {
      const { capacity, refillPerSec, historyPageCost } =
        registry.get(id).rateLimit;
      expect(capacity).toBeGreaterThan(0);
      expect(refillPerSec).toBeGreaterThan(0);
      expect(historyPageCost ?? 1).toBeLessThanOrEqual(capacity);
      expect(1).toBeLessThanOrEqual(capacity); // balance / inspect calls cost 1
    },
  );

  it.each(['nexo', 'pionex'] as const)(
    'throws for unsupported exchange %s',
    (id) => {
      expect(() => registry.get(id)).toThrow(`Unsupported exchange: ${id}`);
    },
  );
});
