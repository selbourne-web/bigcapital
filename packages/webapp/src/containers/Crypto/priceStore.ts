import { useSyncExternalStore } from 'react';

/** A live USD price for one asset, as pushed by the server (`prices:tick`). */
export interface PriceQuote {
  asset: string;
  usd: number;
  source: string;
  /** Epoch milliseconds of the last update at the source. */
  asOf: number;
  stale: boolean;
  /** `USDT` means the price is approximately (not exactly) USD. */
  quote: 'USD' | 'USDT';
  change24hPct?: number;
}

export type PriceMap = Readonly<Record<string, PriceQuote>>;

/*
 * Tiny external store for useSyncExternalStore. The snapshot object is
 * replaced (never mutated) only when something actually changed, so it is
 * referentially stable between changes. No timers; one notification per call.
 */
let snapshot: PriceMap = Object.freeze({});
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

export const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getSnapshot = (): PriceMap => snapshot;

const sameQuote = (a: PriceQuote, b: PriceQuote) =>
  a.usd === b.usd &&
  a.source === b.source &&
  a.asOf === b.asOf &&
  a.stale === b.stale &&
  a.quote === b.quote &&
  a.change24hPct === b.change24hPct;

/** Merges quotes by asset (each replaces the previous quote for that asset). */
export const setQuotes = (quotes: PriceQuote[]): void => {
  let next: Record<string, PriceQuote> | null = null;
  for (const q of quotes) {
    if (!q || typeof q.asset !== 'string' || !Number.isFinite(q.usd)) continue;
    const prev = (next ?? snapshot)[q.asset];
    if (prev && sameQuote(prev, q)) continue;
    next ??= { ...snapshot };
    next[q.asset] = q;
  }
  if (!next) return;
  snapshot = Object.freeze(next);
  emit();
};

/** Marks every known quote stale (used on disconnect); prices are kept. */
export const markAllStale = (): void => {
  let next: Record<string, PriceQuote> | null = null;
  for (const [asset, q] of Object.entries(snapshot)) {
    if (q.stale) continue;
    next ??= { ...snapshot };
    next[asset] = { ...q, stale: true };
  }
  if (!next) return;
  snapshot = Object.freeze(next);
  emit();
};

/** Drops all quotes (e.g. when the organization changes). */
export const clearQuotes = (): void => {
  if (Object.keys(snapshot).length === 0) return;
  snapshot = Object.freeze({});
  emit();
};

export const usePrices = (): PriceMap =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

export const usePrice = (asset: string): PriceQuote | undefined =>
  useSyncExternalStore(
    subscribe,
    () => snapshot[asset],
    () => snapshot[asset],
  );
