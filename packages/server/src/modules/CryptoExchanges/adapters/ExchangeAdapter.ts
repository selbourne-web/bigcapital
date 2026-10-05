import {
  CryptoExchangeId,
  CryptoRecordType,
} from '../CryptoExchanges.constants';

export type Credentials = {
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
};

export type KeyInspection = {
  readOnly: boolean | 'unverifiable';
  permissions: string[];
};

/** Decimal strings; asset already normalized. */
export type RawBalance = { asset: string; free: string; locked: string };

export type RawRecordInput = {
  type: CryptoRecordType;
  exchangeRecordId: string;
  occurredAt: Date;
  payload: unknown;
};

export interface ExchangeAdapter {
  readonly id: CryptoExchangeId;
  readonly rateLimit: { capacity: number; refillPerSec: number };
  inspectKey(c: Credentials): Promise<KeyInspection>;
  fetchBalances(c: Credentials): Promise<RawBalance[]>;
  /**
   * `since` is a lower bound; callers pass a small overlap for clock skew, and each
   * adapter owns any extra overlap its own history semantics need (for example
   * Binance re-scans deposits/withdrawals 14 days before `since` because they are
   * windowed by creation time but recorded on completion). Records are idempotent
   * by `exchangeRecordId`. `knownAssets` (optional, upper-case symbols the caller
   * has already seen, e.g. from stored trades) lets adapters that discover history
   * per market find assets that are no longer held; adapters may ignore it.
   */
  fetchHistory(
    c: Credentials,
    q: { since?: Date; cursor?: string; knownAssets?: string[] },
  ): Promise<{ records: RawRecordInput[]; nextCursor?: string }>;
}
