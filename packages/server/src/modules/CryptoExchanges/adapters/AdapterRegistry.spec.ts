import { AdapterRegistry } from './AdapterRegistry';
import { KrakenAdapter } from './kraken/KrakenAdapter';
import { BinanceAdapter } from './binance/BinanceAdapter';

describe('AdapterRegistry', () => {
  const registry = new AdapterRegistry();

  it('returns the Kraken and Binance adapters', () => {
    expect(registry.get('kraken')).toBeInstanceOf(KrakenAdapter);
    expect(registry.get('binance')).toBeInstanceOf(BinanceAdapter);
    expect(registry.get('kraken').id).toBe('kraken');
    expect(registry.get('binance').id).toBe('binance');
  });

  it.each(['nexo', 'pionex', 'crypto_com'] as const)(
    'throws for unsupported exchange %s',
    (id) => {
      expect(() => registry.get(id)).toThrow(`Unsupported exchange: ${id}`);
    },
  );
});
