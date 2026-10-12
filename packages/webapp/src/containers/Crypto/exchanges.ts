/** Supported crypto exchanges: shared by the connections page and the dashboard. */
export const CRYPTO_EXCHANGES = [
  {
    value: 'kraken',
    label: 'Kraken',
    help: [
      'In Kraken’s API key settings (under Security), create a new API key.',
      'Tick only "Query funds" (add "Query ledger entries" and "Query closed orders & trades" if you want history). Leave every trading, deposit and withdrawal permission off.',
    ],
  },
  {
    value: 'binance',
    label: 'Binance',
    help: [
      'In Binance, open Account > API Management and choose Create API (system generated).',
      'Enable "Enable Reading" only. Leave Spot & Margin Trading, Withdrawals, Futures and Internal Transfer off, and restrict the key to this server’s IP address if you can.',
    ],
  },
  {
    value: 'crypto_com',
    label: 'Crypto.com Exchange',
    help: [
      "In Crypto.com Exchange, open Settings > API Keys and create a key with 'Can Read' only. Leave withdrawals and trading off. Crypto.com cannot confirm a key's permissions, so you will be asked to confirm the key is read-only.",
    ],
  },
  {
    value: 'crypto_com_app',
    label: 'Crypto.com App',
    help: [
      "In the Crypto.com App's API key management, create a key with read-only scopes (balances and history). Keys expire (about 90 days), so Selbourne Financial shows the expiry and asks you to rotate before then.",
    ],
  },
  {
    value: 'pionex',
    label: 'Pionex',
    help: [
      "In Pionex, open API management and create a key with 'Enable reading' only (add 'Bot reading' if you use trading bots). Leave trading and transfer off. Pionex cannot confirm a key's permissions, so you will be asked to confirm the key is read-only.",
    ],
  },
] as const;

/** Exchanges whose API keys carry no passphrase: the Add dialog hides that field. */
const NO_PASSPHRASE = new Set<string>(['pionex']);

/** Whether the Add dialog shows the passphrase field (default true). */
export const needsPassphrase = (value: string): boolean =>
  !NO_PASSPHRASE.has(value);

/** Exchanges that accept CSV report imports (history their API cannot return). */
export const CSV_IMPORT_EXCHANGES: readonly string[] = ['pionex', 'nexo'];

/** Exchanges with no usable API here: connections are created without a key and fed by CSV only. */
export const CSV_ONLY_EXCHANGES = [
  { value: 'nexo', label: 'Nexo (CSV)' },
] as const;

export const supportsCsvImport = (exchange: string): boolean =>
  CSV_IMPORT_EXCHANGES.includes(exchange);

const titleCase = (value: string) =>
  value
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

/** Names of CSV-only exchanges (they are not in the API-key list above). */
const CSV_ONLY_LABELS: Record<string, string> = { nexo: 'Nexo' };

/** Friendly exchange name; unknown ids fall back to a title-cased version. */
export const exchangeLabel = (value: string): string =>
  CRYPTO_EXCHANGES.find((exchange) => exchange.value === value)?.label ??
  CSV_ONLY_LABELS[value] ??
  titleCase(value);
