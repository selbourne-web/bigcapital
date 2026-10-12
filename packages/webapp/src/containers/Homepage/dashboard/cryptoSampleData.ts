/**
 * Fictional crypto data for the dev-only dashboard preview
 * (`?sample=crypto`, `?sample=empty`). Nothing here comes from an exchange.
 *
 * Known figures at 2.0 base units per USD (the Barbados dollar peg):
 * - Kraken main:    0.85 BTC @ 60000 = 102000, 2 ETH @ 2500 (stale quote) =
 *                   10000, 100.5 USD = 201; 5000 DOGE has no price. = 112201
 * - Binance trading (error): 1.123456789012345678 SOL @ 100 USDT = 224.69
 *                   (approximate: priced from a USDT pair).
 * - Kraken savings (account not mapped): 1 ETH @ 2500 (stale) = 5000.
 * Total 117425.69 BBD.
 */
import type { PriceQuote } from '@/containers/Crypto/priceStore';
import type {
  CryptoBalancesResponse,
  CryptoConnection,
} from '@/hooks/query/crypto';
import type { QueryClient } from '@tanstack/react-query';
import { setQuotes } from '@/containers/Crypto/priceStore';
import { CRYPTO_QUERY_KEYS } from '@/hooks/query/crypto';
import { exchangeRateKeys } from '@/hooks/query/exchange-rates/query-keys';

const NOW = () => new Date().toISOString();

export const sampleCryptoConnections = (): CryptoConnection[] => [
  {
    id: 1,
    exchange: 'kraken',
    label: 'Kraken main',
    status: 'active',
    keyHint: 'Q9fA',
    accountId: 11,
    lastSyncAt: NOW(),
    lastError: null,
    createdAt: NOW(),
    keyExpiresAt: null,
    historyCoverage: { level: 'full' },
    mode: 'api',
  },
  {
    id: 2,
    exchange: 'binance',
    label: 'Binance trading',
    status: 'error',
    keyHint: 'x2Lm',
    accountId: 12,
    lastSyncAt: NOW(),
    lastError: 'The exchange rejected the API key.',
    createdAt: NOW(),
    keyExpiresAt: null,
    historyCoverage: { level: 'full' },
    mode: 'api',
  },
  {
    id: 3,
    exchange: 'kraken',
    label: 'Kraken savings',
    status: 'active',
    keyHint: 'b7Zc',
    accountId: null,
    lastSyncAt: NOW(),
    lastError: null,
    createdAt: NOW(),
    keyExpiresAt: null,
    historyCoverage: { level: 'full' },
    mode: 'api',
  },
];

export const sampleCryptoBalances = (): CryptoBalancesResponse => ({
  connections: [
    {
      connectionId: 1,
      accountId: 11,
      capturedAt: NOW(),
      balances: [
        { asset: 'BTC', free: '0.75', locked: '0.10' },
        { asset: 'ETH', free: '2', locked: '0' },
        { asset: 'USD', free: '100.5', locked: '0' },
        { asset: 'DOGE', free: '5000', locked: '0' },
        { asset: 'XRP', free: '0', locked: '0' },
      ],
    },
    {
      connectionId: 2,
      accountId: 12,
      capturedAt: NOW(),
      balances: [{ asset: 'SOL', free: '1.123456789012345678', locked: '0' }],
    },
    {
      connectionId: 3,
      accountId: null,
      capturedAt: NOW(),
      balances: [{ asset: 'ETH', free: '1', locked: '0' }],
    },
  ],
});

export const sampleCryptoQuotes = (): PriceQuote[] => {
  const asOf = Date.now();
  return [
    {
      asset: 'BTC',
      usd: 60000,
      source: 'kraken',
      asOf,
      stale: false,
      quote: 'USD',
      change24hPct: 2.4,
    },
    {
      asset: 'ETH',
      usd: 2500,
      source: 'kraken',
      asOf: asOf - 10 * 60_000,
      stale: true,
      quote: 'USD',
      change24hPct: -1.3,
    },
    {
      asset: 'SOL',
      usd: 100,
      source: 'binance',
      asOf,
      stale: false,
      quote: 'USDT',
      change24hPct: 5.1,
    },
  ];
};

/**
 * Fills the query cache and price store so the crypto widget renders with no
 * request and no socket. `staleTime: Infinity` keeps react-query from asking
 * the real API for the same keys.
 */
export function seedCryptoSample(
  queryClient: QueryClient,
  organizationId: string | null | undefined,
  mode: 'data' | 'empty',
  baseCurrency: string,
): void {
  queryClient.setQueryDefaults(CRYPTO_QUERY_KEYS.all, {
    staleTime: Infinity,
  });
  queryClient.setQueryData(
    CRYPTO_QUERY_KEYS.connections(organizationId),
    mode === 'empty' ? [] : sampleCryptoConnections(),
  );
  queryClient.setQueryData(
    CRYPTO_QUERY_KEYS.balances(organizationId),
    mode === 'empty' ? { connections: [] } : sampleCryptoBalances(),
  );
  // The USD -> base rate the widget asks for (the BBD peg is 2).
  const rateKey = exchangeRateKeys.rate('USD', baseCurrency);
  queryClient.setQueryDefaults(rateKey, { staleTime: Infinity });
  queryClient.setQueryData(rateKey, { exchangeRate: 2 });
  if (mode === 'data') setQuotes(sampleCryptoQuotes());
}
