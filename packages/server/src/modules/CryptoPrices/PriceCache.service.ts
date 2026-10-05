import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { RedisService } from '@liaoliaots/nestjs-redis';
import { PriceQuote } from './feeds/PriceFeed';
import { STALE_AFTER_MS } from './PriceSelector';

export const PRICE_CACHE_OPTIONS = 'CRYPTO_PRICE_CACHE_OPTIONS';
export const PRICE_KEY_PREFIX = 'crypto:prices:';

export interface PriceCacheOptions {
  now?: () => number;
  /** Redis TTL of a mirrored quote. Default 24 h. */
  ttlSeconds?: number;
  /** Minimum gap between Redis writes for one asset. Default 2 s. */
  mirrorIntervalMs?: number;
}

const SOURCES = new Set(['kraken', 'binance', 'crypto_com']);

const parseQuote = (raw: string | null): PriceQuote | undefined => {
  if (!raw) return undefined;
  try {
    const q = JSON.parse(raw);
    if (
      q &&
      typeof q.asset === 'string' &&
      typeof q.usd === 'number' &&
      Number.isFinite(q.usd) &&
      SOURCES.has(q.source) &&
      typeof q.asOf === 'number'
    ) {
      const quote: PriceQuote = {
        asset: q.asset,
        usd: q.usd,
        source: q.source,
        asOf: q.asOf,
        stale: q.stale === true,
        quote: q.quote === 'USDT' ? 'USDT' : 'USD',
      };
      if (typeof q.change24hPct === 'number') {
        quote.change24hPct = q.change24hPct;
      }
      return quote;
    }
  } catch {
    // fall through
  }
  return undefined;
};

/**
 * Last known price per asset: memory first, mirrored to Redis (`crypto:prices:<ASSET>`
 * with a TTL) so another process or a restart starts warm. No tenant data lives here.
 * Redis failures are logged without payloads and never propagate.
 */
@Injectable()
export class PriceCache {
  private readonly logger = new Logger(PriceCache.name);
  private readonly memory = new Map<string, PriceQuote>();
  private readonly lastMirror = new Map<string, number>();
  private readonly now: () => number;
  private readonly ttlSeconds: number;
  private readonly mirrorIntervalMs: number;

  constructor(
    @Optional() private readonly redisService?: RedisService,
    @Optional() @Inject(PRICE_CACHE_OPTIONS) options: PriceCacheOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ttlSeconds = options.ttlSeconds ?? 24 * 3600;
    this.mirrorIntervalMs = options.mirrorIntervalMs ?? 2000;
  }

  async set(quote: PriceQuote): Promise<void> {
    this.memory.set(quote.asset, quote);
    const last = this.lastMirror.get(quote.asset);
    const at = this.now();
    if (last !== undefined && at - last < this.mirrorIntervalMs) return;
    this.lastMirror.set(quote.asset, at);
    const redis = this.redis();
    if (!redis) return;
    try {
      await redis.set(
        `${PRICE_KEY_PREFIX}${quote.asset}`,
        JSON.stringify(quote),
        'EX',
        this.ttlSeconds,
      );
    } catch {
      this.logger.warn('Price mirror write to Redis failed');
    }
  }

  async get(asset: string): Promise<PriceQuote | undefined> {
    const local = this.memory.get(asset);
    if (local) return this.fresh(local);
    const redis = this.redis();
    if (!redis) return undefined;
    try {
      const stored = parseQuote(await redis.get(`${PRICE_KEY_PREFIX}${asset}`));
      return stored ? this.fresh(stored) : undefined;
    } catch {
      this.logger.warn('Price read from Redis failed');
      return undefined;
    }
  }

  async all(): Promise<PriceQuote[]> {
    const merged = new Map<string, PriceQuote>(this.memory);
    const redis = this.redis();
    if (redis) {
      try {
        let cursor = '0';
        do {
          const [next, keys] = await redis.scan(
            cursor,
            'MATCH',
            `${PRICE_KEY_PREFIX}*`,
            'COUNT',
            100,
          );
          cursor = next;
          const missing = keys.filter(
            (k: string) => !merged.has(k.slice(PRICE_KEY_PREFIX.length)),
          );
          if (missing.length) {
            const values: (string | null)[] = await redis.mget(...missing);
            for (const v of values) {
              const q = parseQuote(v);
              if (q && !merged.has(q.asset)) merged.set(q.asset, q);
            }
          }
        } while (cursor !== '0');
      } catch {
        this.logger.warn('Price scan in Redis failed');
      }
    }
    return [...merged.values()].map((q) => this.fresh(q));
  }

  /** A quote older than the silence limit is stale whatever it was when stored. */
  private fresh(q: PriceQuote): PriceQuote {
    if (q.stale || this.now() - q.asOf <= STALE_AFTER_MS) return q;
    return { ...q, stale: true };
  }

  private redis() {
    if (!this.redisService) return undefined;
    try {
      return this.redisService.getOrThrow();
    } catch {
      return undefined;
    }
  }
}
