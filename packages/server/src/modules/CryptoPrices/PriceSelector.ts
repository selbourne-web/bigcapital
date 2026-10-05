import { PriceQuote, PriceSource, SourceTick } from './feeds/PriceFeed';

/** A source silent for longer than this is skipped in favour of the next one. */
export const STALE_AFTER_MS = 30_000;

/** Failover order: Kraken, then Binance, then Crypto.com. */
export const SOURCE_PRECEDENCE: readonly PriceSource[] = [
  'kraken',
  'binance',
  'crypto_com',
];

const toQuote = (t: SourceTick, stale: boolean): PriceQuote => {
  const quote: PriceQuote = {
    asset: t.asset,
    usd: t.usd,
    source: t.source,
    asOf: t.asOf,
    stale,
    quote: t.quote ?? 'USD',
  };
  if (t.change24hPct !== undefined) quote.change24hPct = t.change24hPct;
  return quote;
};

/**
 * Picks the price for one asset from the last tick of each source.
 *
 * The first source in precedence order that spoke within `STALE_AFTER_MS` wins. If every
 * source is silent the most recent last value is returned with `stale: true`; with no
 * ticks at all there is nothing to serve.
 */
export function selectPrice(
  ticks: Partial<Record<PriceSource, SourceTick>>,
  now: number,
): PriceQuote | undefined {
  let latest: SourceTick | undefined;
  for (const source of SOURCE_PRECEDENCE) {
    const tick = ticks[source];
    if (!tick) continue;
    if (now - tick.asOf <= STALE_AFTER_MS) return toQuote(tick, false);
    if (!latest || tick.asOf > latest.asOf) latest = tick;
  }
  return latest ? toQuote(latest, true) : undefined;
}
