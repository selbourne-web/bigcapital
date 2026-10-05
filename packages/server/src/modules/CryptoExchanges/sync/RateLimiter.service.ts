import { Inject, Injectable, Optional } from '@nestjs/common';
import { RedisService } from '@liaoliaots/nestjs-redis';
import { CryptoExchangeId } from '../CryptoExchanges.constants';
import { AdapterRegistry } from '../adapters/AdapterRegistry';
import { ExchangeRateLimitError } from '../adapters/errors';

export const RATE_LIMITER_OPTIONS = 'CRYPTO_RATE_LIMITER_OPTIONS';

export interface RateLimiterOptions {
  /** Redis key prefix; the key is `<prefix>:<exchange>`. Tests inject a unique one. */
  keyPrefix?: string;
  /** Longest total time `acquire` waits for tokens before throwing. Default 30 s. */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type BucketState = { tokens: number; ts: number };
export type BucketStep = {
  granted: boolean;
  state: BucketState;
  /** Milliseconds until `cost` tokens are available; 0 when granted. */
  waitMs: number;
};

const EPSILON = 1e-9;

/**
 * Pure token-bucket step. The Lua script below mirrors this exactly: refill by the
 * time elapsed since `state.ts` (capped at capacity), take `cost` if available,
 * otherwise report how long to wait and leave the bucket untouched.
 */
export function bucketStep(
  state: BucketState | null,
  nowMs: number,
  capacity: number,
  refillPerSec: number,
  cost: number,
): BucketStep {
  const elapsedMs = state ? Math.max(0, nowMs - state.ts) : 0;
  const tokens = state
    ? Math.min(capacity, state.tokens + (elapsedMs / 1000) * refillPerSec)
    : capacity;
  if (tokens + EPSILON >= cost) {
    return {
      granted: true,
      state: { tokens: tokens - cost, ts: nowMs },
      waitMs: 0,
    };
  }
  return {
    granted: false,
    state: state ?? { tokens, ts: nowMs },
    waitMs: Math.ceil(((cost - tokens) / refillPerSec) * 1000),
  };
}

/**
 * KEYS[1] bucket hash {tokens, ts}; ARGV capacity, refillPerSec, cost, ttlMs.
 * Uses the Redis server clock so every app instance shares one time source.
 * Returns {granted (1/0), waitMs}.
 */
export const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = capacity
if data[1] and data[2] then
  local elapsed = math.max(0, now - tonumber(data[2]))
  tokens = math.min(capacity, tonumber(data[1]) + (elapsed / 1000) * refill)
end
if tokens + 1e-9 >= cost then
  redis.call('HSET', KEYS[1], 'tokens', tostring(tokens - cost), 'ts', tostring(now))
  redis.call('PEXPIRE', KEYS[1], ttl)
  return {1, 0}
end
return {0, math.ceil(((cost - tokens) / refill) * 1000)}
`;

/**
 * Redis token bucket per exchange, shared by every tenant and app instance so the
 * exchange sees one budget per IP regardless of who is syncing.
 */
@Injectable()
export class RateLimiter {
  private readonly keyPrefix: string;
  private readonly maxWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly redisService: RedisService,
    private readonly registry: AdapterRegistry,
    @Optional() @Inject(RATE_LIMITER_OPTIONS) options?: RateLimiterOptions,
  ) {
    this.keyPrefix = options?.keyPrefix ?? 'crypto:ratelimit';
    this.maxWaitMs = options?.maxWaitMs ?? 30_000;
    this.sleep =
      options?.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options?.now ?? Date.now;
  }

  /** Resolves once `cost` tokens were taken; throws ExchangeRateLimitError after maxWaitMs. */
  async acquire(exchange: CryptoExchangeId, cost = 1): Promise<void> {
    const { capacity, refillPerSec } = this.registry.get(exchange).rateLimit;
    if (!(cost > 0) || cost > capacity) {
      throw new Error(
        `Rate limit cost ${cost} can never be satisfied for ${exchange} (capacity ${capacity})`,
      );
    }
    const redis = this.redisService.getOrThrow();
    const key = `${this.keyPrefix}:${exchange}`;
    const ttlMs = Math.max(
      1000,
      Math.ceil((capacity / refillPerSec) * 1000) * 2,
    );
    const startedAt = this.now();

    for (;;) {
      const [granted, waitMs] = (await redis.eval(
        TOKEN_BUCKET_LUA,
        1,
        key,
        capacity,
        refillPerSec,
        cost,
        ttlMs,
      )) as [number, number];
      if (Number(granted) === 1) return;

      const remaining = this.maxWaitMs - (this.now() - startedAt);
      if (remaining <= 0) {
        throw new ExchangeRateLimitError(
          `Timed out after ${this.maxWaitMs} ms waiting for ${exchange} rate-limit tokens`,
        );
      }
      await this.sleep(Math.max(1, Math.min(Number(waitMs), remaining)));
    }
  }
}
