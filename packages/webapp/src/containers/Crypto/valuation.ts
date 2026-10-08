import type { PriceMap } from './priceStore';
import type { CryptoBalancesResponse } from '@/hooks/query/crypto';
import {
  useCurrentOrganizationBaseCurrency,
  useLatestExchangeRate,
} from '@/hooks/query';

export interface HoldingRow {
  connectionId: number;
  asset: string;
  quantity: number;
  priceUsd?: number;
  valueBase?: number;
  change24hPct?: number;
  stale: boolean;
  /** The price came from a USDT pair: approximately, not exactly, USD. */
  approximate: boolean;
  /**
   * Priced through the underlying asset of a Binance Simple Earn `LD<X>` wrapper or a
   * Crypto.com `<X>.STAKED` balance (the price is X's quote). Always also `approximate`.
   */
  viaUnderlying?: string;
}

export interface Valuation {
  perConnection: Array<{
    connectionId: number;
    /** Undefined when `hasRate` is false (no fake 0). */
    value: number | undefined;
    stale: boolean;
    /** True when the connection holds a non-zero asset with no price. */
    hasUnpriced: boolean;
  }>;
  /** Undefined when `hasRate` is false. */
  total: number | undefined;
  /** False when `usdToBase` was not a finite positive rate: no base values. */
  hasRate: boolean;
  rows: HoldingRow[];
  /** Assets with a non-zero balance and no price (valued at 0). */
  unpriced: string[];
}

const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Parses an exchange decimal string. Number() keeps roughly 15 significant
 * digits, which is far below display precision for valuation; anything that
 * is not a plain decimal or not finite is treated as 0.
 */
export const parseQuantity = (value: string | undefined | null): number => {
  if (typeof value !== 'string' || !DECIMAL.test(value.trim())) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const USD_ASSETS = new Set(['USD']);

/**
 * Binance Simple Earn wrapper `LD<X>` -> `X` (LDADA -> ADA), also `<X>.STAKED` -> `X`. Balances keep the raw
 * symbol; only pricing looks through. `X` must be 3-17 [A-Z0-9] characters, so the real
 * Lido DAO token LDO is never treated as a wrapper, and a raw symbol that has its own
 * quote is always priced by that quote (see `valueHoldings`).
 * Keep in sync with `earnUnderlying` in
 * packages/server/src/modules/CryptoExchanges/adapters/assets.ts.
 */
const EARN_WRAPPER = /^LD([A-Z0-9]{3,17})$/;
/** Crypto.com Exchange staked balance `<X>.STAKED` -> `X` (same pricing-only contract). */
const STAKED_WRAPPER = /^([A-Z0-9]{2,20})\.STAKED$/;
export const earnUnderlying = (asset: string): string | undefined =>
  EARN_WRAPPER.exec(asset)?.[1] ?? STAKED_WRAPPER.exec(asset)?.[1];

/**
 * Assets quoted in a fraction of another asset's unit: Pionex `METH` is milli-ETH and is
 * stored as `MILLIETH` (it must never be priced as Mantle's `METH`). Price =
 * underlying price x factor. Keep in sync with `UNIT_WRAPPERS` in
 * packages/server/src/modules/CryptoExchanges/adapters/assets.ts.
 */
const UNIT_WRAPPERS: Record<string, { underlying: string; factor: number }> = {
  MILLIETH: { underlying: 'ETH', factor: 0.001 },
};

/** Look-through target and price scale for a wrapper asset (earn wrappers: factor 1). */
export const priceLookThrough = (
  asset: string,
): { underlying: string; factor: number } | undefined => {
  const earn = earnUnderlying(asset);
  if (earn) return { underlying: earn, factor: 1 };
  return Object.prototype.hasOwnProperty.call(UNIT_WRAPPERS, asset)
    ? UNIT_WRAPPERS[asset]
    : undefined;
};

const ownQuote = (prices: PriceMap, asset: string) =>
  Object.prototype.hasOwnProperty.call(prices, asset)
    ? prices[asset]
    : undefined;

/**
 * Values balances (free + locked) as quantity x USD price x `usdToBase`.
 * Zero balances are omitted; assets without a price add 0 and are listed in
 * `unpriced`. A row is stale when its quote is stale or `socketConnected` is
 * false. The USD pseudo-asset is priced at 1.0. When `usdToBase` is not a
 * finite positive number, `hasRate` is false and no base-currency value is
 * produced (`valueBase`, per-connection `value` and `total` are undefined);
 * prices, quantities and `unpriced` are still reported. Pure; no side effects.
 */
export const valueHoldings = (
  balances: CryptoBalancesResponse | undefined,
  prices: PriceMap,
  usdToBase: number,
  socketConnected = true,
): Valuation => {
  const rows: HoldingRow[] = [];
  const perConnection: Valuation['perConnection'] = [];
  const unpriced = new Set<string>();
  const hasRate = Number.isFinite(usdToBase) && usdToBase > 0;

  for (const conn of balances?.connections ?? []) {
    let value = 0;
    let stale = false;
    let hasUnpriced = false;
    for (const b of conn.balances) {
      const quantity = parseQuantity(b.free) + parseQuantity(b.locked);
      if (quantity === 0) continue;

      const isUsd = USD_ASSETS.has(b.asset);
      let quote = isUsd ? undefined : ownQuote(prices, b.asset);
      let viaUnderlying: string | undefined;
      let factor = 1;
      if (!isUsd && quote === undefined) {
        const look = priceLookThrough(b.asset);
        const underlyingQuote = look
          ? ownQuote(prices, look.underlying)
          : undefined;
        if (look && underlyingQuote) {
          quote = underlyingQuote;
          viaUnderlying = look.underlying;
          factor = look.factor;
        }
      }
      const priceUsd = isUsd
        ? 1
        : quote?.usd === undefined
          ? undefined
          : quote.usd * factor;

      if (priceUsd === undefined) {
        unpriced.add(b.asset);
        hasUnpriced = true;
        rows.push({
          connectionId: conn.connectionId,
          asset: b.asset,
          quantity,
          stale: !socketConnected,
          approximate: false,
        });
        continue;
      }

      const valueBase = hasRate ? quantity * priceUsd * usdToBase : undefined;
      const rowStale = !isUsd && ((quote?.stale ?? false) || !socketConnected);
      value += valueBase ?? 0;
      stale = stale || rowStale;
      rows.push({
        connectionId: conn.connectionId,
        asset: b.asset,
        quantity,
        priceUsd,
        valueBase,
        change24hPct: quote?.change24hPct,
        stale: rowStale,
        // An earn token is redeemable 1:1 for its underlying only approximately.
        approximate: viaUnderlying !== undefined || quote?.quote === 'USDT',
        ...(viaUnderlying ? { viaUnderlying } : {}),
      });
    }
    perConnection.push({
      connectionId: conn.connectionId,
      value: hasRate ? value : undefined,
      stale,
      hasUnpriced,
    });
  }

  return {
    perConnection,
    total: hasRate
      ? perConnection.reduce((sum, c) => sum + (c.value ?? 0), 0)
      : undefined,
    hasRate,
    rows,
    unpriced: [...unpriced],
  };
};

/** Fixed Barbados dollar peg: 2 BBD per 1 USD. */
export const BBD_PEG = 2.0;

/**
 * USD -> organization base currency rate.
 * - base USD: 1.
 * - otherwise the existing exchange-rates hook (server needs an
 *   OpenExchangeRate app id, so the call can fail or be unavailable).
 * - rate call failed/unavailable and base is BBD: the fixed peg 2.0 with
 *   `isFallback: true`.
 * - any other case (still loading, failed, unknown base): `rate: 0`. The UI
 *   must treat 0 as "no rate" and show "-"/a notice instead of a value.
 */
export function useUsdToBase(): { rate: number; isFallback: boolean } {
  const baseCurrency = useCurrentOrganizationBaseCurrency();
  const isUsd = baseCurrency === 'USD';
  const query = useLatestExchangeRate(
    { fromCurrency: 'USD', toCurrency: baseCurrency },
    { enabled: !!baseCurrency && !isUsd, retry: 1 },
  );

  if (isUsd) return { rate: 1, isFallback: false };
  const fetched = Number(query.data?.exchangeRate);
  if (Number.isFinite(fetched) && fetched > 0) {
    return { rate: fetched, isFallback: false };
  }
  if (baseCurrency === 'BBD' && (query.isError || !query.isLoading)) {
    return { rate: BBD_PEG, isFallback: true };
  }
  return { rate: 0, isFallback: false };
}
