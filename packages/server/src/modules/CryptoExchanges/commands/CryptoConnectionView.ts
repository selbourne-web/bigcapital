import { CryptoConnection } from '../models/CryptoConnection';
import {
  CryptoConnectionStatus,
  CryptoExchangeId,
} from '../CryptoExchanges.constants';

/** What the API returns for a connection. Never contains credentials. */
export interface CryptoConnectionView {
  id: number;
  exchange: CryptoExchangeId;
  label: string;
  status: CryptoConnectionStatus;
  keyHint: string | null;
  accountId: number | null;
  lastSyncAt: Date | null;
  lastError: string | null;
  createdAt: Date | null;
}

/** Explicit allow-list copy so a new column can never leak by accident. */
export const toConnectionView = (
  c: CryptoConnection,
): CryptoConnectionView => ({
  id: c.id,
  exchange: c.exchange,
  label: c.label,
  status: c.status,
  keyHint: c.keyHint ?? null,
  accountId: c.accountId ?? null,
  lastSyncAt: c.lastSyncAt ?? null,
  lastError: c.lastError ?? null,
  createdAt: c.createdAt ?? null,
});
