import { Logger } from '@nestjs/common';
import { PriceFeedManager } from './PriceFeedManager.service';
import { PriceCache } from './PriceCache.service';
import { PriceFeed, PriceQuote, SourceTick } from './feeds/PriceFeed';

class FakeFeed implements PriceFeed {
  starts = 0;
  stops = 0;
  subscriptions: string[][] = [];
  private onTick: (t: SourceTick) => void = () => undefined;
  private onClose: () => void = () => undefined;
  constructor(readonly source: PriceFeed['source']) {}
  start(onTick: (t: SourceTick) => void, onClose?: () => void) {
    this.starts += 1;
    this.onTick = onTick;
    this.onClose = onClose ?? (() => undefined);
  }
  subscribe(assets: string[]) {
    this.subscriptions.push([...assets]);
  }
  stop() {
    this.stops += 1;
  }
  // test controls
  tick(asset: string, usd: number, quote: 'USD' | 'USDT' = 'USD') {
    this.onTick({ asset, usd, source: this.source, asOf: Date.now(), quote });
  }
  close() {
    this.onClose();
  }
  get lastSubscription() {
    return this.subscriptions[this.subscriptions.length - 1];
  }
}

const setup = (initialHeld: string[] = [], overrides: any = {}) => {
  let held = initialHeld;
  const redis = {
    smembers: jest.fn(async () => held),
  };
  const feeds = [
    new FakeFeed('kraken'),
    new FakeFeed('binance'),
    new FakeFeed('crypto_com'),
  ];
  const cache = new PriceCache(undefined);
  const manager = new PriceFeedManager(
    { getOrThrow: () => redis } as any,
    cache,
    { feeds, random: () => 0.5, ...overrides },
  );
  const quotes: PriceQuote[] = [];
  manager.onQuote((q) => quotes.push(q));
  return {
    manager,
    feeds,
    redis,
    cache,
    quotes,
    setHeld: (h: string[]) => {
      held = h;
    },
    init: async () => {
      manager.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
    },
  };
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('PriceFeedManager', () => {
  it('opens no feed while the held-assets set is empty (lazy connect)', async () => {
    const t = setup([]);
    await t.init();
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.redis.smembers).toHaveBeenCalledWith('crypto:held-assets');
    for (const f of t.feeds) {
      expect(f.starts).toBe(0);
    }
    t.manager.onModuleDestroy();
  });

  it('starts every feed and subscribes only the held assets', async () => {
    const t = setup(['ETH', 'BTC']);
    await t.init();
    for (const f of t.feeds) {
      expect(f.starts).toBe(1);
      expect(f.lastSubscription).toEqual(['BTC', 'ETH']);
    }
    t.manager.onModuleDestroy();
  });

  it('ignores set members that are not plain asset symbols', async () => {
    const t = setup(['BTC', 'bad symbol', '', 'A'.repeat(21), 'ETH"']);
    await t.init();
    expect(t.feeds[0].lastSubscription).toEqual(['BTC']);
    t.manager.onModuleDestroy();
  });

  it('reconciles every 60 s: additions subscribe, removals unsubscribe', async () => {
    const t = setup(['BTC', 'ETH']);
    await t.init();
    t.setHeld(['BTC', 'SOL']);
    await jest.advanceTimersByTimeAsync(59_000);
    expect(t.feeds[0].lastSubscription).toEqual(['BTC', 'ETH']);
    await jest.advanceTimersByTimeAsync(1_000);
    for (const f of t.feeds) {
      expect(f.lastSubscription).toEqual(['BTC', 'SOL']);
      expect(f.starts).toBe(1);
    }
    t.manager.onModuleDestroy();
  });

  it('stops all feeds after the set has been empty past the grace period, and restarts on demand', async () => {
    const t = setup(['BTC'], { emptyGraceMs: 5 * 60_000 });
    await t.init();
    t.setHeld([]);
    await jest.advanceTimersByTimeAsync(3 * 60_000);
    for (const f of t.feeds) expect(f.stops).toBe(0);
    await jest.advanceTimersByTimeAsync(3 * 60_000);
    for (const f of t.feeds) expect(f.stops).toBe(1);
    t.setHeld(['BTC']);
    await jest.advanceTimersByTimeAsync(60_000);
    for (const f of t.feeds) expect(f.starts).toBe(2);
    t.manager.onModuleDestroy();
  });

  it('does not stop feeds when the set refills inside the grace period', async () => {
    const t = setup(['BTC'], { emptyGraceMs: 5 * 60_000 });
    await t.init();
    t.setHeld([]);
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    t.setHeld(['BTC']);
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    for (const f of t.feeds) {
      expect(f.stops).toBe(0);
      expect(f.starts).toBe(1);
    }
    t.manager.onModuleDestroy();
  });

  it('restarts a closed feed after a jittered, growing backoff', async () => {
    const t = setup(['BTC']);
    await t.init();
    const kraken = t.feeds[0];
    kraken.close();
    // attempt 0: 1000 + 0.5 * (2000 - 1000) = 1500 ms
    await jest.advanceTimersByTimeAsync(1_499);
    expect(kraken.starts).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(kraken.starts).toBe(2);
    expect(kraken.lastSubscription).toEqual(['BTC']);
    kraken.close();
    // attempt 1: 1000 + 0.5 * (4000 - 1000) = 2500 ms
    await jest.advanceTimersByTimeAsync(2_499);
    expect(kraken.starts).toBe(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(kraken.starts).toBe(3);
    // other feeds untouched
    expect(t.feeds[1].starts).toBe(1);
    t.manager.onModuleDestroy();
  });

  it('caps the backoff at 60 s and resets it after a tick', async () => {
    const t = setup(['BTC'], { random: () => 1 });
    await t.init();
    const kraken = t.feeds[0];
    const delays: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      const before = kraken.starts;
      kraken.close();
      let waited = 0;
      while (kraken.starts === before && waited < 120_000) {
        await jest.advanceTimersByTimeAsync(500);
        waited += 500;
      }
      delays.push(waited);
    }
    expect(Math.max(...delays)).toBeLessThanOrEqual(60_000);
    expect(delays[delays.length - 1]).toBeGreaterThanOrEqual(59_500);
    kraken.tick('BTC', 1);
    const before = kraken.starts;
    kraken.close();
    await jest.advanceTimersByTimeAsync(2_000);
    expect(kraken.starts).toBe(before + 1);
    t.manager.onModuleDestroy();
  });

  it('does not restart a feed that closes after the set emptied and feeds were stopped', async () => {
    const t = setup(['BTC'], { emptyGraceMs: 60_000 });
    await t.init();
    t.setHeld([]);
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    t.feeds[0].close();
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(t.feeds[0].starts).toBe(1);
    t.manager.onModuleDestroy();
  });

  it('emits quotes through onQuote and caches them', async () => {
    const t = setup(['BTC']);
    await t.init();
    t.feeds[0].tick('BTC', 65000);
    expect(t.quotes).toHaveLength(1);
    expect(t.quotes[0]).toMatchObject({
      asset: 'BTC',
      usd: 65000,
      source: 'kraken',
      stale: false,
      quote: 'USD',
    });
    expect(await t.cache.get('BTC')).toMatchObject({ usd: 65000 });
    t.manager.onModuleDestroy();
  });

  it('does not re-emit when a lower-precedence source ticks while Kraken is fresh', async () => {
    const t = setup(['BTC']);
    await t.init();
    t.feeds[0].tick('BTC', 65000);
    t.feeds[1].tick('BTC', 64990, 'USDT');
    t.feeds[2].tick('BTC', 64995);
    expect(t.quotes).toHaveLength(1);
    t.manager.onModuleDestroy();
  });

  it('fails over to Binance (marked USDT) and emits when Kraken goes silent', async () => {
    const t = setup(['BTC']);
    await t.init();
    t.feeds[0].tick('BTC', 65000);
    await jest.advanceTimersByTimeAsync(31_000);
    t.feeds[1].tick('BTC', 64990, 'USDT');
    const last = t.quotes[t.quotes.length - 1];
    expect(last).toMatchObject({
      usd: 64990,
      source: 'binance',
      quote: 'USDT',
      stale: false,
    });
    t.manager.onModuleDestroy();
  });

  it('emits a stale quote once every source has been silent past the limit', async () => {
    const t = setup(['BTC']);
    await t.init();
    t.feeds[0].tick('BTC', 65000);
    t.quotes.length = 0;
    await jest.advanceTimersByTimeAsync(45_000);
    expect(t.quotes).toHaveLength(1);
    expect(t.quotes[0]).toMatchObject({ usd: 65000, stale: true });
    await jest.advanceTimersByTimeAsync(20_000);
    expect(t.quotes).toHaveLength(1);
    t.manager.onModuleDestroy();
  });

  it('onQuote returns an unsubscribe function and isolates throwing listeners', async () => {
    const t = setup(['BTC']);
    await t.init();
    const bad = jest.fn(() => {
      throw new Error('listener');
    });
    const good = jest.fn();
    t.manager.onQuote(bad);
    const off = t.manager.onQuote(good);
    t.feeds[0].tick('BTC', 1);
    expect(good).toHaveBeenCalledTimes(1);
    off();
    t.feeds[0].tick('BTC', 2);
    expect(good).toHaveBeenCalledTimes(1);
    t.manager.onModuleDestroy();
  });

  it('survives Redis failures during reconcile and keeps the current state', async () => {
    const t = setup(['BTC']);
    await t.init();
    t.redis.smembers.mockRejectedValueOnce(new Error('redis down'));
    await expect(jest.advanceTimersByTimeAsync(60_000)).resolves.not.toThrow();
    for (const f of t.feeds) {
      expect(f.stops).toBe(0);
      expect(f.starts).toBe(1);
    }
    t.manager.onModuleDestroy();
  });

  it('onModuleDestroy stops feeds, clears every timer and prevents restarts', async () => {
    const t = setup(['BTC']);
    await t.init();
    t.feeds[0].close(); // pending restart timer
    t.manager.onModuleDestroy();
    for (const f of t.feeds) expect(f.stops).toBe(1);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.feeds[0].starts).toBe(1);
  });
});
