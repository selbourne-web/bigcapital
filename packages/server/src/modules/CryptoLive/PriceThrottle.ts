import { PriceQuote } from '../CryptoPrices/feeds/PriceFeed';

export interface ThrottleTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PriceThrottle {
  /** Remembers the quote; only the latest one per asset survives until the next flush. */
  push(quote: PriceQuote): void;
  /** Cancels the pending flush and drops pending quotes. */
  stop(): void;
}

/** Looked up at call time so test fake timers installed later still apply. */
const defaultTimers: ThrottleTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * Coalesces quotes to the latest per asset and flushes them in one batch at most
 * once per `intervalMs`. The timer exists only while quotes are pending, so an idle
 * throttle holds no timer.
 */
export const createPriceThrottle = (
  emit: (ticks: PriceQuote[]) => void,
  intervalMs = 1000,
  timers: ThrottleTimers = defaultTimers,
): PriceThrottle => {
  const pending = new Map<string, PriceQuote>();
  let handle: unknown;

  const flush = () => {
    handle = undefined;
    if (pending.size === 0) return;
    const ticks = [...pending.values()];
    pending.clear();
    emit(ticks);
  };

  return {
    push(quote) {
      pending.set(quote.asset, quote);
      if (handle === undefined) {
        handle = timers.setTimeout(flush, intervalMs);
      }
    },
    stop() {
      if (handle !== undefined) {
        timers.clearTimeout(handle);
        handle = undefined;
      }
      pending.clear();
    },
  };
};
