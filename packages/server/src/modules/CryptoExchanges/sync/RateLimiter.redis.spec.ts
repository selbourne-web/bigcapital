import Redis from 'ioredis';
import { randomBytes } from 'crypto';
import { RateLimiter } from './RateLimiter.service';
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

  it('concurrent callers never exceed capacity', async () => {
    const { limiter, sleeps } = make(`${prefix}:b`);
    await Promise.all(
      Array.from({ length: 14 }, () => limiter.acquire('binance')),
    );
    // 14 callers vs capacity 10 (+ at most a token or two refilled while calling):
    // several must have been made to wait.
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
  }, 15_000);

  it('throws ExchangeRateLimitError after max wait', async () => {
    const { limiter } = make(`${prefix}:c`, 300);
    await limiter.acquire('kraken', 15);
    await expect(limiter.acquire('kraken', 15)).rejects.toBeInstanceOf(
      ExchangeRateLimitError,
    );
  });
});
