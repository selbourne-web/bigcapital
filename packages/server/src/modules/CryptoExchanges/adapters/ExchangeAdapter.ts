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
  fetchHistory(
    c: Credentials,
    q: { since?: Date; cursor?: string },
  ): Promise<{ records: RawRecordInput[]; nextCursor?: string }>;
}
