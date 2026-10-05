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
