import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { RedisService } from '@liaoliaots/nestjs-redis';
import { CRYPTO_HELD_ASSETS_KEY } from '../CryptoExchanges/CryptoExchanges.constants';
import { PriceCache } from './PriceCache.service';
import { selectPrice } from './PriceSelector';
import {
  isPriceableAsset,
  PriceFeed,
  PriceQuote,
  PriceSource,
  SourceTick,
} from './feeds/PriceFeed';
import { KrakenTickerFeed } from './feeds/KrakenTickerFeed';
import { BinanceTickerFeed } from './feeds/BinanceTickerFeed';
import { CryptoComTickerFeed } from './feeds/CryptoComTickerFeed';

export const PRICE_FEED_MANAGER_OPTIONS = 'CRYPTO_PRICE_FEED_MANAGER_OPTIONS';

export interface PriceFeedManagerOptions {
  /** Defaults to the Kraken, Binance and Crypto.com feeds; tests inject fakes. */
  feeds?: PriceFeed[];
  now?: () => number;
  /** Returns [0, 1). */
  random?: () => number;
  /** Held-assets reconcile period. Default 60 s. */
  reconcileMs?: number;
  /** How often silent quotes are re-evaluated for staleness. Default 10 s. */
  sweepMs?: number;
  /** Feeds are closed once the held set has been empty this long. Default 5 min. */
  emptyGraceMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
}

type FeedState = {
  feed: PriceFeed;
  running: boolean;
  attempts: number;
  retryTimer?: ReturnType<typeof setTimeout>;
};

/**
 * Owns the price feeds. Lazy: no socket is opened until the Redis set `crypto:held-assets`
 * has at least one asset, and the feeds are closed again once it has been empty for the
 * grace period. Every `reconcileMs` it re-reads the set and subscribes the feeds to
 * exactly those assets. Closed feeds restart with jittered exponential backoff
 * (min 1 s, max 60 s); the backoff resets after a feed delivers a tick.
 */
@Injectable()
export class PriceFeedManager implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PriceFeedManager.name);
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly reconcileMs: number;
  private readonly sweepMs: number;
  private readonly emptyGraceMs: number;
  private readonly backoffMinMs: number;
  private readonly backoffMaxMs: number;

  private readonly states: FeedState[];
  private readonly listeners = new Set<(q: PriceQuote) => void>();
  private readonly ticks = new Map<
    string,
    Partial<Record<PriceSource, SourceTick>>
  >();
  private readonly lastEmitted = new Map<string, PriceQuote>();

  private assets: string[] = [];
  private active = false;
  private emptySince: number | undefined;
  private destroyed = false;
  private reconcileTimer: ReturnType<typeof setInterval> | undefined;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private reconciling = false;

  constructor(
    private readonly redisService: RedisService,
    private readonly cache: PriceCache,
    @Optional()
    @Inject(PRICE_FEED_MANAGER_OPTIONS)
    options: PriceFeedManagerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.reconcileMs = options.reconcileMs ?? 60_000;
    this.sweepMs = options.sweepMs ?? 10_000;
    this.emptyGraceMs = options.emptyGraceMs ?? 5 * 60_000;
    this.backoffMinMs = options.backoffMinMs ?? 1_000;
    this.backoffMaxMs = options.backoffMaxMs ?? 60_000;
    const feeds = options.feeds ?? [
      new KrakenTickerFeed(),
      new BinanceTickerFeed(),
      new CryptoComTickerFeed(),
    ];
    this.states = feeds.map((feed) => ({
      feed,
      running: false,
      attempts: 0,
    }));
  }

  onModuleInit() {
    this.reconcileTimer = setInterval(
      () => void this.reconcile(),
      this.reconcileMs,
    );
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepMs);
    void this.reconcile();
  }

  onModuleDestroy() {
    this.destroyed = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.reconcileTimer = this.sweepTimer = undefined;
    this.stopFeeds();
    this.listeners.clear();
  }

  /** Subscribes to every quote change; returns the unsubscribe function. */
  onQuote(cb: (q: PriceQuote) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Reads the held set and brings feeds and subscriptions in line with it. */
  async reconcile(): Promise<void> {
    if (this.destroyed || this.reconciling) return;
    this.reconciling = true;
    try {
      const members = await this.redisService
        .getOrThrow()
        .smembers(CRYPTO_HELD_ASSETS_KEY);
      if (this.destroyed) return;
      this.applyHeldAssets(members);
    } catch {
      // Keep the current state; never log the error object (may carry connection details).
      this.logger.warn('Held-assets reconcile failed; keeping current feeds');
    } finally {
      this.reconciling = false;
    }
  }

  private applyHeldAssets(members: string[]) {
    const assets = [...new Set(members.filter(isPriceableAsset))].sort();
    if (assets.length === 0) {
      this.assets = [];
      const at = this.now();
      this.emptySince ??= at;
      if (this.active && at - this.emptySince >= this.emptyGraceMs) {
        this.stopFeeds();
      }
      return;
    }
    this.emptySince = undefined;
    this.assets = assets;
    for (const asset of this.ticks.keys()) {
      if (!assets.includes(asset)) this.ticks.delete(asset);
    }
    this.active = true;
    for (const state of this.states) {
      if (!state.running && !state.retryTimer) this.startFeed(state);
      state.feed.subscribe(assets);
    }
  }

  private startFeed(state: FeedState) {
    state.running = true;
    state.feed.start(
      (tick) => this.onTick(state, tick),
      () => this.onFeedClosed(state),
    );
    state.feed.subscribe(this.assets);
  }

  private onFeedClosed(state: FeedState) {
    if (!state.running) return;
    state.running = false;
    if (this.destroyed || !this.active) return;
    const delay = this.backoffDelay(state.attempts);
    state.attempts += 1;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined;
      if (this.destroyed || !this.active || state.running) return;
      this.startFeed(state);
    }, delay);
  }

  /** min + random * (cap - min), cap doubling from 2 x min up to the maximum. */
  private backoffDelay(attempt: number): number {
    const cap = Math.min(
      this.backoffMaxMs,
      this.backoffMinMs * 2 ** Math.min(attempt + 1, 20),
    );
    return Math.round(
      this.backoffMinMs + this.random() * (cap - this.backoffMinMs),
    );
  }

  private stopFeeds() {
    this.active = false;
    for (const state of this.states) {
      if (state.retryTimer) clearTimeout(state.retryTimer);
      state.retryTimer = undefined;
      state.running = false;
      state.attempts = 0;
      state.feed.stop();
    }
  }

  private onTick(state: FeedState, tick: SourceTick) {
    state.attempts = 0;
    if (this.destroyed || !this.assets.includes(tick.asset)) return;
    const perSource = this.ticks.get(tick.asset) ?? {};
    perSource[tick.source] = tick;
    this.ticks.set(tick.asset, perSource);
    this.publish(tick.asset);
  }

  /** Re-evaluates silent assets so a source going quiet still produces a stale quote. */
  private sweep() {
    for (const asset of this.ticks.keys()) this.publish(asset);
  }

  private publish(asset: string) {
    const quote = selectPrice(this.ticks.get(asset) ?? {}, this.now());
    if (!quote) return;
    void this.cache.set(quote);
    const prev = this.lastEmitted.get(asset);
    if (
      prev &&
      prev.usd === quote.usd &&
      prev.source === quote.source &&
      prev.quote === quote.quote &&
      prev.stale === quote.stale
    ) {
      return;
    }
    this.lastEmitted.set(asset, quote);
    for (const cb of this.listeners) {
      try {
        cb(quote);
      } catch {
        this.logger.warn('A price listener threw');
      }
    }
  }
}
