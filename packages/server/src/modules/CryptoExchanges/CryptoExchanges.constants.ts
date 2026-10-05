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

/** Permission actions for the CryptoExchange ability subject. */
export const CryptoExchangeAction = {
  View: 'View',
  Create: 'Create',
  Edit: 'Edit',
  Delete: 'Delete',
} as const;
