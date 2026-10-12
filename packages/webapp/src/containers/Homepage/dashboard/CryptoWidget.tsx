/**
 * Crypto holdings widget for the homepage dashboard.
 *
 * Data: balances and connection status come from the REST hooks; live prices
 * come from the price store (fed by `useCryptoLive`). A price tick therefore
 * re-renders this widget through `usePrices` only, and never refetches a
 * query. Secrets and balances never travel over the socket.
 *
 * Money rules: values are quantity x USD price x the USD -> base rate. When
 * there is no rate the widget says so instead of showing 0.00; assets without
 * a price are flagged and left out of the total.
 */
import { Icon } from '@blueprintjs/core';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Link } from 'react-router-dom';
import { WidgetCard } from './WidgetCard';
import { useMoney } from './Widgets';
import type { HoldingRow } from '@/containers/Crypto/valuation';
import type { CryptoConnection } from '@/hooks/query/crypto';
import { DonutChart, chartCssVars } from '@/components/Charts';
import { exchangeLabel } from '@/containers/Crypto/exchanges';
import { usePrices } from '@/containers/Crypto/priceStore';
import { useCryptoLive } from '@/containers/Crypto/useCryptoLive';
import { useUsdToBase, valueHoldings } from '@/containers/Crypto/valuation';
import {
  isCsvOnly,
  useCryptoBalances,
  useCryptoConnections,
} from '@/hooks/query/crypto';

const CONNECTIONS_PATH = '/preferences/crypto-connections';
/** Screen readers hear the total at most this often, never once per tick. */
const ANNOUNCE_EVERY_MS = 30_000;
const COUNT_UP_MS = 900;
/** How long to wait for the first price tick before saying prices are unavailable. */
const PRICE_WAIT_MS = 12_000;

// --- small hooks -----------------------------------------------------------

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(REDUCED_MOTION);
      query.addEventListener('change', notify);
      return () => query.removeEventListener('change', notify);
    },
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
}

/**
 * Counts up from 0 to the first value it sees (the reveal), then follows the
 * value directly: ticks must not restart an animation. With reduced motion it
 * never animates.
 */
function useCountUp(target: number | undefined, animate: boolean) {
  const [shown, setShown] = useState<number | undefined>(undefined);
  const revealed = useRef(false);

  useEffect(() => {
    if (target === undefined) return undefined;
    if (revealed.current || !animate) {
      revealed.current = true;
      setShown(target);
      return undefined;
    }
    revealed.current = true;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / COUNT_UP_MS);
      // Exponential ease-out, like the chart reveal.
      const eased = progress === 1 ? 1 : 1 - 2 ** (-10 * progress);
      setShown(target * eased);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, animate]);

  if (target === undefined) return undefined;
  return shown ?? (animate ? 0 : target);
}

/** Leading + trailing throttle: the first change is immediate. */
function useThrottled<T>(value: T, ms: number): T {
  const [output, setOutput] = useState(value);
  const lastAt = useRef(0);

  useEffect(() => {
    if (value === output) return undefined;
    const wait = Math.max(0, lastAt.current + ms - Date.now());
    const timer = setTimeout(() => {
      lastAt.current = Date.now();
      setOutput(value);
    }, wait);
    return () => clearTimeout(timer);
  }, [value, output, ms]);

  return output;
}

/** True only after `condition` has held for `ms`, to avoid flashing notices. */
function useHeldFor(condition: boolean, ms: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!condition) {
      setHeld(false);
      return undefined;
    }
    const timer = setTimeout(() => setHeld(true), ms);
    return () => clearTimeout(timer);
  }, [condition, ms]);
  return condition && held;
}

// --- formatting -------------------------------------------------------------

const quantityFormat = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 8,
});
const priceFormat = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 1 ? 2 : 6,
  }).format(value);

const formatChange = (pct: number) =>
  `${pct > 0 ? '+' : pct < 0 ? '-' : ''}${Math.abs(pct).toFixed(2)}%`;

// --- parts ------------------------------------------------------------------

interface AssetRow {
  asset: string;
  quantity: number;
  priceUsd?: number;
  valueBase?: number;
  change24hPct?: number;
  stale: boolean;
  approximate: boolean;
  viaUnderlying?: string;
}

/** One row per asset across all connections, largest value first. */
function aggregateByAsset(rows: HoldingRow[]): AssetRow[] {
  const byAsset = new Map<string, AssetRow>();
  for (const row of rows) {
    const existing = byAsset.get(row.asset);
    if (!existing) {
      byAsset.set(row.asset, {
        asset: row.asset,
        quantity: row.quantity,
        priceUsd: row.priceUsd,
        valueBase: row.valueBase,
        change24hPct: row.change24hPct,
        stale: row.stale,
        approximate: row.approximate,
        viaUnderlying: row.viaUnderlying,
      });
      continue;
    }
    existing.quantity += row.quantity;
    if (row.valueBase !== undefined) {
      existing.valueBase = (existing.valueBase ?? 0) + row.valueBase;
    }
    existing.stale = existing.stale || row.stale;
    existing.approximate = existing.approximate || row.approximate;
    existing.viaUnderlying ??= row.viaUnderlying;
  }
  return [...byAsset.values()].sort(
    (a, b) =>
      (b.valueBase ?? -1) - (a.valueBase ?? -1) ||
      a.asset.localeCompare(b.asset),
  );
}

function StatusStrip({ connections }: { connections: CryptoConnection[] }) {
  return (
    <ul className="dash-crypto__status" aria-label="Exchange connections">
      {connections.map((connection) => {
        const isError = connection.status === 'error';
        const isPaused = connection.status === 'paused';
        const csvOnly = isCsvOnly(connection);
        return (
          <li
            key={connection.id}
            className={`dash-crypto__conn${isError ? ' is-error' : ''}`}
          >
            <span className="dash-crypto__conn-name">{connection.label}</span>
            <span className="dash-crypto__conn-exchange">
              {exchangeLabel(connection.exchange)}
            </span>
            <span
              className={`dash-crypto__badge${isError ? ' dash-crypto__badge--error' : ''}`}
            >
              <Icon
                icon={
                  isError
                    ? 'error'
                    : isPaused
                      ? 'pause'
                      : csvOnly
                        ? 'document'
                        : 'tick-circle'
                }
                size={12}
                aria-hidden="true"
              />
              {isError
                ? 'Needs attention'
                : isPaused
                  ? 'Paused'
                  : csvOnly
                    ? 'CSV only'
                    : 'Connected'}
            </span>
            {isError && (
              <Link
                className="dash-pill dash-pill--small"
                to={CONNECTIONS_PATH}
                title={connection.lastError ?? undefined}
              >
                Reconnect
              </Link>
            )}
            {connection.accountId == null && (
              <Link className="dash-crypto__hint" to={CONNECTIONS_PATH}>
                Account not mapped
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ChangeCell({ pct }: { pct: number | undefined }) {
  if (pct === undefined) {
    return (
      <>
        <span aria-hidden="true">-</span>
        <span className="dash-crypto__sr">No 24 hour change available</span>
      </>
    );
  }
  const up = pct > 0;
  const down = pct < 0;
  return (
    <span
      className={`dash-crypto__change${up ? ' is-up' : down ? ' is-down' : ''}`}
    >
      {(up || down) && (
        <Icon
          icon={up ? 'arrow-up' : 'arrow-down'}
          size={11}
          aria-hidden="true"
        />
      )}
      {formatChange(pct)}
    </span>
  );
}

// --- widget -----------------------------------------------------------------

/** Chart palette for the exchange donut: brand series, labelled in the legend. */
const connectionColor = (index: number) =>
  chartCssVars.series[index % chartCssVars.series.length];

function CryptoHoldings({
  connections,
  balances,
}: {
  connections: CryptoConnection[];
  balances: NonNullable<ReturnType<typeof useCryptoBalances>['data']>;
}) {
  // Mounted only while there are connections, so an empty widget opens no socket.
  useCryptoLive();

  const { full, whole } = useMoney();
  const prices = usePrices();
  const { rate, isFallback } = useUsdToBase();
  const reducedMotion = usePrefersReducedMotion();

  const valuation = useMemo(
    () => valueHoldings(balances, prices, rate),
    [balances, prices, rate],
  );
  const rows = useMemo(
    () => aggregateByAsset(valuation.rows),
    [valuation.rows],
  );

  const awaitingPrices =
    Object.keys(prices).length === 0 && rows.some((row) => row.asset !== 'USD');
  const anyStale = rows.some((row) => row.stale);
  const unpricedAssets = awaitingPrices ? [] : valuation.unpriced;

  // After a while with no tick, stop saying "waiting"; a later tick recovers.
  const pricesUnavailable = useHeldFor(awaitingPrices, PRICE_WAIT_MS);
  const showTotal = valuation.hasRate && !awaitingPrices && rows.length > 0;
  const counted = useCountUp(
    showTotal ? valuation.total : undefined,
    !reducedMotion,
  );
  const noRateNotice = useHeldFor(!valuation.hasRate, 1200);

  const slices = useMemo(
    () =>
      valuation.perConnection
        .map((entry, index) => ({
          key: String(entry.connectionId),
          label:
            connections.find((c) => c.id === entry.connectionId)?.label ??
            `Connection ${entry.connectionId}`,
          value: entry.value ?? 0,
          color: connectionColor(index),
        }))
        .filter((slice) => slice.value > 0),
    [valuation.perConnection, connections],
  );

  // Screen readers get a calm, throttled summary instead of every tick.
  const summary = !valuation.hasRate
    ? 'Crypto holdings: no exchange rate available.'
    : pricesUnavailable
      ? 'Crypto holdings: live prices unavailable.'
      : awaitingPrices
        ? 'Crypto holdings: waiting for live prices.'
        : `Crypto holdings total ${whole(valuation.total ?? 0)}${anyStale ? ', prices are stale' : ''}.`;
  const announced = useThrottled(summary, ANNOUNCE_EVERY_MS);

  const needsAttention = connections.filter((c) => c.status === 'error');
  // CSV-only connections hold no balances, so they do not count here.
  const balanceConnections = connections.filter((c) => !isCsvOnly(c));
  const onlyCsv = connections.length > 0 && balanceConnections.length === 0;

  return (
    <>
      <p className="dash-crypto__sr" role="status" aria-live="polite">
        {announced}
      </p>

      <StatusStrip connections={connections} />

      <div className="dash-crypto__summary">
        <div className="dash-crypto__total">
          <div className="dash-kpi">
            <span className="dash-kpi__label">Total crypto value</span>
            {showTotal ? (
              <span className="dash-kpi__value" aria-hidden="true">
                {full(counted ?? 0)}
              </span>
            ) : (
              <span className="dash-kpi__value dash-kpi__value--none">
                {awaitingPrices && valuation.hasRate && !pricesUnavailable
                  ? 'Waiting'
                  : '-'}
              </span>
            )}
            <span className="dash-kpi__meta">
              {pricesUnavailable
                ? 'Live prices unavailable'
                : awaitingPrices
                  ? 'Waiting for live prices'
                  : rows.length === 0
                    ? 'No balances'
                    : `${rows.length} ${rows.length === 1 ? 'asset' : 'assets'} across ${balanceConnections.length} ${balanceConnections.length === 1 ? 'connection' : 'connections'}`}
            </span>
          </div>

          <div className="dash-crypto__badges">
            {anyStale && (
              <span className="dash-crypto__badge dash-crypto__badge--warn">
                <Icon icon="time" size={12} aria-hidden="true" />
                Stale prices
              </span>
            )}
            {isFallback && (
              <span className="dash-crypto__badge">
                Fixed BBD peg: 2.00 per USD
              </span>
            )}
          </div>

          {!valuation.hasRate && noRateNotice && (
            <p className="dash-crypto__notice">
              <strong>No exchange rate.</strong> Values in your base currency
              can&apos;t be shown until a USD rate is available. Quantities and
              USD prices are still listed below.
            </p>
          )}
          {pricesUnavailable && (
            <p className="dash-crypto__notice">
              <Icon icon="warning-sign" size={12} aria-hidden="true" /> Live
              prices are unavailable right now. Quantities are listed; values
              appear when prices arrive.
            </p>
          )}
          {needsAttention.length > 0 && (
            <p className="dash-crypto__notice dash-crypto__notice--error">
              {needsAttention.length === 1
                ? `${needsAttention[0].label} needs attention, so its balances may be out of date.`
                : `${needsAttention.length} connections need attention, so their balances may be out of date.`}
            </p>
          )}
          {unpricedAssets.length > 0 && (
            <p className="dash-crypto__notice">
              <Icon icon="warning-sign" size={12} aria-hidden="true" /> No price
              for {unpricedAssets.join(', ')}. Not included in the total.
            </p>
          )}
        </div>

        {valuation.hasRate && slices.length > 0 && (
          <div className="dash-crypto__donut">
            <DonutChart
              slices={slices}
              centerLabel="Total value"
              centerValue={whole(valuation.total ?? 0)}
              formatValue={whole}
              ariaLabel="Crypto value by exchange connection"
              size={152}
            />
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="dash-card__message">
          {onlyCsv
            ? 'No balances. CSV-only connections hold no balances; import a CSV export on the connections page to add history.'
            : 'No balances yet. Use Sync now on the connections page to import them.'}
        </p>
      ) : (
        <table className="dash-crypto__table">
          <caption className="dash-crypto__sr">
            Crypto holdings by asset
          </caption>
          <thead>
            <tr>
              <th scope="col">Asset</th>
              <th scope="col" className="dash-crypto__num dash-crypto__col-qty">
                Quantity
              </th>
              <th
                scope="col"
                className="dash-crypto__num dash-crypto__col-price"
              >
                Price (USD)
              </th>
              <th scope="col" className="dash-crypto__num">
                Value
              </th>
              <th scope="col" className="dash-crypto__num">
                24h
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const unpriced = row.priceUsd === undefined && !awaitingPrices;
              return (
                <tr key={row.asset}>
                  <th scope="row" className="dash-crypto__asset">
                    <span>{row.asset}</span>
                    <span className="dash-crypto__qty-inline">
                      {quantityFormat.format(row.quantity)}
                    </span>
                  </th>
                  <td className="dash-crypto__num dash-crypto__col-qty">
                    {quantityFormat.format(row.quantity)}
                  </td>
                  <td className="dash-crypto__num dash-crypto__col-price">
                    {row.priceUsd === undefined ? (
                      unpriced ? (
                        <span className="dash-crypto__badge dash-crypto__badge--warn">
                          <Icon
                            icon="warning-sign"
                            size={11}
                            aria-hidden="true"
                          />
                          No price
                        </span>
                      ) : (
                        '-'
                      )
                    ) : (
                      <>
                        {row.approximate && (
                          <span
                            className="dash-crypto__badge"
                            title={
                              row.viaUnderlying
                                ? `Earn/staked token priced via ${row.viaUnderlying}, so approximately USD`
                                : 'Priced from a USDT pair, so approximately USD'
                            }
                          >
                            ≈USD
                          </span>
                        )}
                        {row.viaUnderlying && (
                          <span
                            className="dash-crypto__badge"
                            title={`Priced from ${row.viaUnderlying}`}
                          >
                            via {row.viaUnderlying}
                          </span>
                        )}
                        {row.stale && (
                          <span className="dash-crypto__badge dash-crypto__badge--warn">
                            Stale
                          </span>
                        )}{' '}
                        {priceFormat(row.priceUsd)}
                      </>
                    )}
                  </td>
                  <td className="dash-crypto__num dash-crypto__value">
                    {row.valueBase === undefined ? (
                      <>
                        <span aria-hidden="true">-</span>
                        <span className="dash-crypto__sr">
                          {valuation.hasRate
                            ? 'Not valued'
                            : 'No exchange rate'}
                        </span>
                      </>
                    ) : (
                      full(row.valueBase)
                    )}
                    {row.priceUsd !== undefined &&
                      (row.approximate || row.stale) && (
                        <span className="dash-crypto__flags">
                          {row.approximate && '≈USD'}
                          {row.approximate && row.stale && ' · '}
                          {row.stale && 'Stale'}
                        </span>
                      )}
                  </td>
                  <td className="dash-crypto__num">
                    <ChangeCell pct={row.change24hPct} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

export function CryptoWidget() {
  const connections = useCryptoConnections();
  const balances = useCryptoBalances();

  const list = connections.data ?? [];
  const isLoading = connections.isLoading || balances.isLoading;
  const error = connections.error ?? balances.error;

  return (
    <WidgetCard
      title="Crypto holdings"
      size="full"
      action={{ label: 'Manage connections', to: CONNECTIONS_PATH }}
      isLoading={isLoading}
      error={error}
      onRetry={() => {
        connections.refetch();
        balances.refetch();
      }}
      isEmpty={list.length === 0}
      emptyText="Connect an exchange to see your crypto balances and their value here."
      emptyAction={{ label: 'Connect an exchange', to: CONNECTIONS_PATH }}
    >
      {balances.data && (
        <CryptoHoldings connections={list} balances={balances.data} />
      )}
    </WidgetCard>
  );
}
