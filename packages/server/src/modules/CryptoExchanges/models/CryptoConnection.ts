import { TenantBaseModel } from '@/modules/System/models/TenantBaseModel';
import {
  CryptoConnectionStatus,
  CryptoExchangeId,
} from '../CryptoExchanges.constants';

export class CryptoConnection extends TenantBaseModel {
  id: number;
  exchange: CryptoExchangeId;
  label: string;
  apiKeyEncrypted: string;
  apiSecretEncrypted: string;
  passphraseEncrypted?: string | null;
  keyVersion: number;
  keyHint?: string | null;
  status: CryptoConnectionStatus;
  lastSyncAt?: Date | null;
  lastError?: string | null;
  accountId?: number | null;
  /** Opaque adapter cursor of an interrupted history slice. */
  syncCursor?: string | null;
  /** Start of the last completed (or first initial) sync; incremental windows begin here. */
  lastSeenAt?: Date | null;
  initialSyncCompletedAt?: Date | null;
  /** Expiry reported by the exchange for this key (e.g. Crypto.com App keys); null when none. */
  keyExpiresAt?: Date | null;
  /**
   * Set when the user removed the connection but kept its data: credentials and
   * account mapping are wiped, the row stays so the cascading child rows survive.
   * Every connection query must filter `deleted_at IS NULL`.
   */
  deletedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;

  static get tableName() {
    return 'crypto_connections';
  }

  /**
   * Hide encrypted secrets from any serialized output.
   */
  $formatJson(json) {
    const formatted = super.$formatJson(json);
    delete formatted.apiKeyEncrypted;
    delete formatted.apiSecretEncrypted;
    delete formatted.passphraseEncrypted;
    return formatted;
  }
}
