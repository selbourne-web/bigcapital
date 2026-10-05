import { RateLimiter, bucketStep } from './RateLimiter.service';
import { ExchangeRateLimitError } from '../adapters/errors';
import { AdapterRegistry } from '../adapters/AdapterRegistry';

describe('bucketStep (pure bucket math the Lua script mirrors)', () => {
  it('starts full and takes cost', () => {
    const r = bucketStep(null, 1000, 5, 1, 2);
    expect(r).toMatchObject({ granted: true, waitMs: 0 });
    expect(r.state.tokens).toBe(3);
  });

  it('refills by elapsed time, capped at capacity', () => {
    const r = bucketStep({ tokens: 0, ts: 0 }, 1_000_000, 5, 1, 1);
    expect(r.state.tokens).toBe(4);
  });

  it('reports the wait for a deficit without taking tokens', () => {
    const r = bucketStep({ tokens: 0, ts: 1000 }, 1000, 5, 2, 1);
    expect(r.granted).toBe(false);
    expect(r.waitMs).toBe(500);
    expect(r.state.tokens).toBe(0);
  });

  it('ignores a clock that moved backwards', () => {
    const r = bucketStep({ tokens: 1, ts: 5000 }, 4000, 5, 1, 1);
    expect(r.granted).toBe(true);
    expect(r.state.tokens).toBe(0);
  });
});

/**
 * In-memory stand-in for Redis `eval` that runs bucketStep on a fake clock.
 * It tests the acquire loop only; the Lua script itself is exercised in
 * RateLimiter.redis.spec.ts against a real Redis.
 */
function setup(maxWaitMs = 30_000) {
  let clock = 1_000_000;
  const buckets = new Map<string, { tokens: number; ts: number }>();
  const evalFn = jest.fn(
    async (
      _script: string,
      _n: number,
      key: string,
      capacity: number,
      refill: number,
      cost: number,
    ) => {
      const r = bucketStep(
        buckets.get(key) ?? null,
        clock,
        capacity,
        refill,
        cost,
      );
      if (r.granted) buckets.set(key, r.state);
      return [r.granted ? 1 : 0, r.waitMs];
    },
  );
  const sleeps: number[] = [];
  const limiter = new RateLimiter(
    { getOrThrow: () => ({ eval: evalFn }) } as any,
    new AdapterRegistry(),
    {
      maxWaitMs,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    },
  );
  return { limiter, evalFn, sleeps, clockMs: () => clock };
}

describe('RateLimiter.acquire (fake Redis eval, fake clock)', () => {
  it('allows capacity immediate acquires, then waits 1/refillPerSec', async () => {
    const { limiter, sleeps } = setup();
    for (let i = 0; i < 10; i++) await limiter.acquire('binance'); // capacity 10
    expect(sleeps).toEqual([]);
    await limiter.acquire('binance'); // refill 2/s -> 500 ms
    expect(sleeps).toEqual([500]);
  });

  it('charges the given cost', async () => {
    const { limiter, sleeps } = setup();
    await limiter.acquire('kraken', 15);
    await limiter.acquire('kraken', 2); // 2 tokens at 0.33/s -> 6061 ms
    expect(sleeps).toEqual([6061]);
  });

  it('keeps separate buckets per exchange', async () => {
    const { limiter, sleeps } = setup();
    await limiter.acquire('kraken', 15);
    await limiter.acquire('binance');
    expect(sleeps).toEqual([]);
  });

  it('concurrent callers never exceed capacity at the same instant', async () => {
    const { limiter, clockMs } = setup();
    const start = clockMs();
    const done: number[] = [];
    await Promise.all(
      Array.from({ length: 14 }, () =>
        limiter.acquire('binance').then(() => done.push(clockMs() - start)),
      ),
    );
    expect(done).toHaveLength(14);
    expect(done.filter((t) => t === 0).length).toBeLessThanOrEqual(10);
  });

  it('rejects a cost above capacity immediately', async () => {
    const { limiter, evalFn } = setup();
    await expect(limiter.acquire('binance', 11)).rejects.toThrow(
      /can never be satisfied/,
    );
    expect(evalFn).not.toHaveBeenCalled();
  });

  it('throws ExchangeRateLimitError once max wait is exhausted', async () => {
    const { limiter, sleeps } = setup(1000);
    await limiter.acquire('kraken', 15);
    await expect(limiter.acquire('kraken', 15)).rejects.toBeInstanceOf(
      ExchangeRateLimitError,
    );
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('throws for unsupported exchanges', async () => {
    const { limiter } = setup();
    await expect(limiter.acquire('nexo')).rejects.toThrow(
      'Unsupported exchange: nexo',
    );
  });
});
