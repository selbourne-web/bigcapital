import { AdapterRegistry } from './AdapterRegistry';
import { KrakenAdapter } from './kraken/KrakenAdapter';
import { BinanceAdapter } from './binance/BinanceAdapter';
import { CryptoComAdapter } from './cryptocom/CryptoComAdapter';

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

  it.each(['nexo', 'pionex'] as const)(
    'throws for unsupported exchange %s',
    (id) => {
      expect(() => registry.get(id)).toThrow(`Unsupported exchange: ${id}`);
    },
  );
});
