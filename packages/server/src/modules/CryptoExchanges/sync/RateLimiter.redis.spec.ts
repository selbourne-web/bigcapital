import Redis from 'ioredis';
import { randomBytes } from 'crypto';
import {
  RateLimiter,
  TOKEN_BUCKET_LUA,
  bucketStep,
} from './RateLimiter.service';
import { AdapterRegistry } from '../adapters/AdapterRegistry';
import { ExchangeRateLimitError } from '../adapters/errors';

/**
 * Runs the real Lua script against the dev Redis. Skipped unless TEST_REDIS=1.
 * Uses a unique `crypto:test:<random>` key prefix and deletes only its own keys.
 * Assertions count sleeps (not wall-clock time) so a slow machine cannot flake them.
 */
const describeRedis = process.env.TEST_REDIS === '1' ? describe : describe.skip;

describeRedis('RateLimiter against real Redis', () => {
  let client: Redis;
  const prefix = `crypto:test:${randomBytes(6).toString('hex')}`;
  const make = (p: string, maxWaitMs?: number) => {
    const sleeps: number[] = [];
    const limiter = new RateLimiter(
      { getOrThrow: () => client } as any,
      new AdapterRegistry(),
      {
        keyPrefix: p,
        maxWaitMs,
        sleep: (ms) => {
          sleeps.push(ms);
          return new Promise((resolve) => setTimeout(resolve, ms));
        },
      },
    );
    return { limiter, sleeps };
  };

  beforeAll(() => {
    client = new Redis({
      host: process.env.REDIS_HOST || '::1',
      port: Number(process.env.REDIS_PORT) || 6379,
      family: 0,
    });
  });

  afterAll(async () => {
    const keys = await client.keys(`${prefix}*`);
    if (keys.length) await client.del(...keys);
    client.disconnect();
  });

  it('allows capacity immediately then delays; sets an expiry', async () => {
    const { limiter, sleeps } = make(`${prefix}:a`);
    for (let i = 0; i < 10; i++) await limiter.acquire('binance'); // capacity 10
    expect(sleeps).toEqual([]);
    await limiter.acquire('binance'); // refill 2/s -> waits at most 500 ms
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[0]).toBeLessThanOrEqual(500);
    expect(await client.pttl(`${prefix}:a:binance`)).toBeGreaterThan(0);
  });

  it('grants exactly capacity tokens to 50 concurrent callers (atomic Lua)', async () => {
    const key = `${prefix}:b:atomic`;
    const capacity = 10;
    // Negligible refill makes the outcome deterministic: any over-grant is a bug.
    const results = (await Promise.all(
      Array.from({ length: 50 }, () =>
        client.eval(TOKEN_BUCKET_LUA, 1, key, capacity, 0.0001, 1, 60_000),
      ),
    )) as [number, number][];
    const granted = results.filter(([g]) => Number(g) === 1);
    const denied = results.filter(([g]) => Number(g) === 0);
    expect(granted).toHaveLength(capacity);
    expect(denied).toHaveLength(40);
    expect(denied.every(([, waitMs]) => Number(waitMs) > 0)).toBe(true);
  }, 15_000);

  describe('Lua matches bucketStep', () => {
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    type Bucket = { tokens: number; ts: number } | null;

    const readBucket = async (key: string): Promise<Bucket> => {
      const [tokens, ts] = await client.hmget(key, 'tokens', 'ts');
      return tokens === null || ts === null
        ? null
        : { tokens: Number(tokens), ts: Number(ts) };
    };

    /**
     * Takes `cost` through the real Lua, then replays the same step through the
     * pure function using the Redis-recorded timestamp as "now" and the previous
     * stored state; the resulting token counts must agree.
     */
    const stepBoth = async (
      key: string,
      capacity: number,
      refill: number,
      cost: number,
    ) => {
      const prev = await readBucket(key);
      const [granted, waitMs] = (await client.eval(
        TOKEN_BUCKET_LUA,
        1,
        key,
        capacity,
        refill,
        cost,
        60_000,
      )) as [number, number];
      const next = await readBucket(key);
      return { prev, next, granted: Number(granted) === 1, waitMs };
    };

    it('first use starts full; fractional refill; clamp after a long wait', async () => {
      const key = `${prefix}:c:parity`;
      const capacity = 3;
      const refill = 100; // 100 tokens/s keeps waits tiny

      // First use: bucket starts at capacity.
      let r = await stepBoth(key, capacity, refill, 3);
      expect(r.prev).toBeNull();
      expect(r.granted).toBe(true);
      let expected = bucketStep(null, r.next!.ts, capacity, refill, 3);
      expect(r.next!.tokens).toBeCloseTo(expected.state.tokens, 6);
      expect(r.next!.tokens).toBeCloseTo(0, 6);

      // Fractional refill: ~20 ms refills about 2 tokens, then take 1.
      await delay(20);
      r = await stepBoth(key, capacity, refill, 1);
      expect(r.granted).toBe(true);
      expected = bucketStep(r.prev, r.next!.ts, capacity, refill, 1);
      expect(expected.granted).toBe(true);
      expect(r.next!.tokens).toBeCloseTo(expected.state.tokens, 6);
      expect(r.next!.tokens).toBeGreaterThan(0);
      expect(r.next!.tokens).toBeLessThanOrEqual(capacity - 1);

      // Clamp: 100 ms would refill 10 tokens but the bucket holds only 3.
      await delay(100);
      r = await stepBoth(key, capacity, refill, 1);
      expect(r.granted).toBe(true);
      expected = bucketStep(r.prev, r.next!.ts, capacity, refill, 1);
      expect(r.next!.tokens).toBeCloseTo(expected.state.tokens, 6);
      expect(r.next!.tokens).toBeCloseTo(capacity - 1, 6);
    });

    it('denial leaves the bucket untouched and reports a positive wait', async () => {
      const key = `${prefix}:c:denied`;
      await stepBoth(key, 2, 0.0001, 2); // drain
      const r = await stepBoth(key, 2, 0.0001, 1);
      expect(r.granted).toBe(false);
      expect(r.waitMs).toBeGreaterThan(0);
      expect(r.next).toEqual(r.prev);
      const expected = bucketStep(r.prev, r.prev!.ts, 2, 0.0001, 1);
      expect(expected.granted).toBe(false);
      // Lua evaluates a few ms after prev.ts, so its wait is marginally shorter.
      expect(r.waitMs).toBeLessThanOrEqual(expected.waitMs);
      expect(r.waitMs).toBeGreaterThan(expected.waitMs * 0.99);
    });
  });

  it('throws ExchangeRateLimitError after max wait', async () => {
    const { limiter } = make(`${prefix}:c`, 300);
    await limiter.acquire('kraken', 15);
    await expect(limiter.acquire('kraken', 15)).rejects.toBeInstanceOf(
      ExchangeRateLimitError,
    );
  });
});
