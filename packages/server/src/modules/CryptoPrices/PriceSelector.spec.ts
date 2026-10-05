import { selectPrice, STALE_AFTER_MS } from './PriceSelector';
import { SourceTick } from './feeds/PriceFeed';

const NOW = 1_800_000_000_000;

const tick = (
  source: SourceTick['source'],
  usd: number,
  ageMs: number,
  extra: Partial<SourceTick> = {},
): SourceTick => ({
  asset: 'BTC',
  usd,
  source,
  asOf: NOW - ageMs,
  quote: 'USD',
  ...extra,
});

describe('selectPrice', () => {
  it('prefers Kraken when it is fresh', () => {
    const q = selectPrice(
      {
        kraken: tick('kraken', 100, 1_000),
        binance: tick('binance', 101, 0),
        crypto_com: tick('crypto_com', 102, 0),
      },
      NOW,
    );
    expect(q).toMatchObject({
      asset: 'BTC',
      usd: 100,
      source: 'kraken',
      stale: false,
    });
  });

  it('keeps a source that is exactly at the silence limit', () => {
    const q = selectPrice({ kraken: tick('kraken', 100, STALE_AFTER_MS) }, NOW);
    expect(q).toMatchObject({ source: 'kraken', stale: false });
  });

  it('falls over to Binance when Kraken is 31 s old', () => {
    const q = selectPrice(
      {
        kraken: tick('kraken', 100, 31_000),
        binance: tick('binance', 101, 2_000, { quote: 'USDT' }),
        crypto_com: tick('crypto_com', 102, 0),
      },
      NOW,
    );
    expect(q).toMatchObject({ usd: 101, source: 'binance', stale: false });
  });

  it('falls over to Crypto.com when Kraken and Binance are both older', () => {
    const q = selectPrice(
      {
        kraken: tick('kraken', 100, 45_000),
        binance: tick('binance', 101, 31_000),
        crypto_com: tick('crypto_com', 102, 5_000),
      },
      NOW,
    );
    expect(q).toMatchObject({ usd: 102, source: 'crypto_com', stale: false });
  });

  it('serves the most recent last value with stale:true when every source is silent', () => {
    const q = selectPrice(
      {
        kraken: tick('kraken', 100, 90_000),
        binance: tick('binance', 101, 40_000),
        crypto_com: tick('crypto_com', 102, 60_000),
      },
      NOW,
    );
    expect(q).toMatchObject({ usd: 101, source: 'binance', stale: true });
    expect(q.asOf).toBe(NOW - 40_000);
  });

  it('returns undefined when there are no ticks', () => {
    expect(selectPrice({}, NOW)).toBeUndefined();
  });

  it('marks a USDT-quoted price instead of presenting it as USD', () => {
    const q = selectPrice(
      { binance: tick('binance', 65000, 1_000, { quote: 'USDT' }) },
      NOW,
    );
    expect(q.quote).toBe('USDT');
    const k = selectPrice({ kraken: tick('kraken', 65000, 1_000) }, NOW);
    expect(k.quote).toBe('USD');
  });

  it('carries the 24h change when the source reports it', () => {
    const q = selectPrice(
      { kraken: tick('kraken', 100, 0, { change24hPct: -1.5 }) },
      NOW,
    );
    expect(q.change24hPct).toBe(-1.5);
  });
});
