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
      const quote = isUsd
        ? undefined
        : Object.prototype.hasOwnProperty.call(prices, b.asset)
          ? prices[b.asset]
          : undefined;
      const priceUsd = isUsd ? 1 : quote?.usd;

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
        approximate: quote?.quote === 'USDT',
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
