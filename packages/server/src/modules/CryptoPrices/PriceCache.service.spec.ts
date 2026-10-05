import { Logger } from '@nestjs/common';
import { PriceCache } from './PriceCache.service';
import { PriceQuote } from './feeds/PriceFeed';

const NOW = 1_800_000_000_000;

const quote = (asset: string, usd: number, extra: Partial<PriceQuote> = {}) =>
  ({
    asset,
    usd,
    source: 'kraken',
    asOf: NOW,
    stale: false,
    quote: 'USD',
    ...extra,
  }) as PriceQuote;

/** Minimal in-memory stand-in for the ioredis calls PriceCache uses. */
const fakeRedis = () => {
  const store = new Map<string, string>();
  return {
    store,
    set: jest.fn(async (k: string, v: string, ..._rest: unknown[]) => {
      store.set(k, v);
      return 'OK';
    }),
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    scan: jest.fn(async (_cursor: string, _m: string, pattern: string) => {
      const prefix = pattern.replace('*', '');
      return ['0', [...store.keys()].filter((k) => k.startsWith(prefix))];
    }),
    mget: jest.fn(async (...keys: string[]) =>
      keys.map((k) => store.get(k) ?? null),
    ),
  };
};

const redisService = (client: any) => ({ getOrThrow: () => client }) as any;

describe('PriceCache', () => {
  let now = NOW;
  const opts = { now: () => now, mirrorIntervalMs: 2000 };
  beforeEach(() => {
    now = NOW;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('serves what was set from memory', async () => {
    const cache = new PriceCache(undefined, opts);
    await cache.set(quote('BTC', 65000));
    expect(await cache.get('BTC')).toMatchObject({ usd: 65000, stale: false });
    expect(await cache.get('ETH')).toBeUndefined();
    expect(await cache.all()).toHaveLength(1);
  });

  it('marks a quote stale once it is older than the silence limit', async () => {
    const cache = new PriceCache(undefined, opts);
    await cache.set(quote('BTC', 65000));
    now = NOW + 31_000;
    expect(await cache.get('BTC')).toMatchObject({ usd: 65000, stale: true });
  });

  it('mirrors to Redis under crypto:prices:<ASSET> with a TTL', async () => {
    const redis = fakeRedis();
    const cache = new PriceCache(redisService(redis), opts);
    await cache.set(quote('BTC', 65000));
    expect(redis.set).toHaveBeenCalledWith(
      'crypto:prices:BTC',
      expect.any(String),
      'EX',
      expect.any(Number),
    );
    const ttl = redis.set.mock.calls[0][3];
    expect(ttl).toBeGreaterThan(0);
    expect(JSON.parse(redis.store.get('crypto:prices:BTC')).usd).toBe(65000);
  });

  it('throttles the Redis mirror per asset', async () => {
    const redis = fakeRedis();
    const cache = new PriceCache(redisService(redis), opts);
    await cache.set(quote('BTC', 1));
    await cache.set(quote('BTC', 2));
    await cache.set(quote('ETH', 3));
    expect(redis.set).toHaveBeenCalledTimes(2);
    now = NOW + 2000;
    await cache.set(quote('BTC', 4));
    expect(redis.set).toHaveBeenCalledTimes(3);
    expect((await cache.get('BTC')).usd).toBe(4);
  });

  it('starts warm from Redis in a fresh process and flags old values stale', async () => {
    const redis = fakeRedis();
    await new PriceCache(redisService(redis), opts).set(quote('BTC', 65000));
    now = NOW + 120_000;
    const fresh = new PriceCache(redisService(redis), opts);
    expect(await fresh.get('BTC')).toMatchObject({ usd: 65000, stale: true });
    expect(await fresh.all()).toHaveLength(1);
  });

  it('ignores malformed or foreign values in Redis', async () => {
    const redis = fakeRedis();
    redis.store.set('crypto:prices:BAD', '{nope');
    redis.store.set(
      'crypto:prices:EVIL',
      JSON.stringify({ asset: 'EVIL', usd: 'x', source: 'kraken', asOf: 1 }),
    );
    redis.store.set(
      'crypto:prices:ODD',
      JSON.stringify({ asset: 'ODD', usd: 1, source: 'nowhere', asOf: 1 }),
    );
    const cache = new PriceCache(redisService(redis), opts);
    expect(await cache.get('BAD')).toBeUndefined();
    expect(await cache.get('EVIL')).toBeUndefined();
    expect(await cache.get('ODD')).toBeUndefined();
    expect(await cache.all()).toEqual([]);
  });

  it('keeps working from memory when Redis fails', async () => {
    const failing = {
      set: jest.fn().mockRejectedValue(new Error('redis down')),
      get: jest.fn().mockRejectedValue(new Error('redis down')),
      scan: jest.fn().mockRejectedValue(new Error('redis down')),
      mget: jest.fn().mockRejectedValue(new Error('redis down')),
    };
    const cache = new PriceCache(redisService(failing), opts);
    await expect(cache.set(quote('BTC', 65000))).resolves.toBeUndefined();
    expect(await cache.get('BTC')).toMatchObject({ usd: 65000 });
    expect(await cache.get('ETH')).toBeUndefined();
    expect(await cache.all()).toHaveLength(1);
  });

  it('survives getOrThrow itself throwing', async () => {
    const cache = new PriceCache(
      {
        getOrThrow: () => {
          throw new Error('no client');
        },
      } as any,
      opts,
    );
    await expect(cache.set(quote('BTC', 1))).resolves.toBeUndefined();
    expect(await cache.get('BTC')).toMatchObject({ usd: 1 });
  });
});
