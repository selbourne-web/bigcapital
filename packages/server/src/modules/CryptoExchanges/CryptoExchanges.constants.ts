export type CryptoExchangeId =
  | 'kraken'
  | 'binance'
  | 'crypto_com'
  | 'pionex'
  | 'nexo';

export type CryptoConnectionStatus = 'active' | 'paused' | 'error';

export type CryptoRecordType =
  | 'trade'
  | 'deposit'
  | 'withdrawal'
  | 'fee'
  | 'reward'
  /** Response that did not match the documented shape; stored so no data is lost. */
  | 'unparsed';

export type CryptoSyncKind = 'initial' | 'incremental' | 'manual';

/** Exchanges with an adapter in piece 1; validated at the DTO layer. */
export const SUPPORTED_CRYPTO_EXCHANGES: readonly CryptoExchangeId[] = [
  'kraken',
  'binance',
];

export const CRYPTO_CONNECTION_STATUSES: readonly CryptoConnectionStatus[] = [
  'active',
  'paused',
  'error',
];

/** Statuses a user may set; `error` is only ever set by the system. */
export const CRYPTO_USER_SETTABLE_STATUSES = ['active', 'paused'] as const;

export const CRYPTO_SYNC_KINDS: readonly CryptoSyncKind[] = [
  'initial',
  'incremental',
  'manual',
];

/** Account type used for accounts created on behalf of a connection (current asset). */
export const CRYPTO_ACCOUNT_TYPE = 'other-current-asset';

export const CRYPTO_CONNECTION_ERRORS = {
  NOT_FOUND: 'CRYPTO_CONNECTION_NOT_FOUND',
  EXCHANGE_NOT_SUPPORTED: 'CRYPTO_EXCHANGE_NOT_SUPPORTED',
  IN_ERROR: 'CRYPTO_CONNECTION_IN_ERROR',
  CREDENTIALS_REQUIRED: 'CRYPTO_CREDENTIALS_REQUIRED',
  ACCOUNT_NOT_FOUND: 'CRYPTO_ACCOUNT_NOT_FOUND',
  ACCOUNT_NOT_ASSET: 'CRYPTO_ACCOUNT_NOT_ASSET',
  ACCOUNT_INACTIVE: 'CRYPTO_ACCOUNT_INACTIVE',
  ACCOUNT_CURRENCY_MISMATCH: 'CRYPTO_ACCOUNT_CURRENCY_MISMATCH',
  ACCOUNT_ALREADY_MAPPED: 'CRYPTO_ACCOUNT_ALREADY_MAPPED',
  ACCOUNT_MAPPING_CONFLICT: 'CRYPTO_ACCOUNT_MAPPING_CONFLICT',
} as const;

/** Permission actions for the CryptoExchange ability subject. */
export const CryptoExchangeAction = {
  View: 'View',
  Create: 'Create',
  Edit: 'Edit',
  Delete: 'Delete',
} as const;

/** One BullMQ queue per exchange so one exchange outage or rate limit never blocks the other. */
export const CRYPTO_SYNC_QUEUES: Readonly<Record<string, string>> = {
  kraken: 'crypto-sync-kraken',
  binance: 'crypto-sync-binance',
};
export const CRYPTO_SYNC_KRAKEN_QUEUE = CRYPTO_SYNC_QUEUES.kraken;
export const CRYPTO_SYNC_BINANCE_QUEUE = CRYPTO_SYNC_QUEUES.binance;
export const CRYPTO_SYNC_QUEUE_NAMES = [
  CRYPTO_SYNC_KRAKEN_QUEUE,
  CRYPTO_SYNC_BINANCE_QUEUE,
] as const;

/** Name of the queue that syncs `exchange`; throws for exchanges without an adapter. */
export const queueNameFor = (exchange: CryptoExchangeId | string): string => {
  const name = CRYPTO_SYNC_QUEUES[exchange];
  if (!name) {
    throw new Error(`No crypto sync queue for exchange "${exchange}"`);
  }
  return name;
};

/** BullMQ job name used on every crypto sync queue. */
export const CRYPTO_SYNC_JOB = 'crypto-sync';

/** Retry policy of every sync job (rate-limit/network errors back off exponentially). */
export const CRYPTO_SYNC_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 30000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 24 * 3600, count: 1000 },
} as const;

/** Redis set of asset symbols held on any connection; feeds the price feed (Task 10). */
export const CRYPTO_HELD_ASSETS_KEY = 'crypto:held-assets';
export const CRYPTO_HELD_ASSETS_TTL_SECONDS = 24 * 3600;

/** Id of the repeatable (scheduler) job of a connection. */
export const cryptoScheduleId = (connectionId: number) =>
  `crypto-sync:${connectionId}`;
