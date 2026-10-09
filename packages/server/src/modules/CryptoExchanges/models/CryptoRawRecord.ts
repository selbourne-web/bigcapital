import { TenantBaseModel } from '@/modules/System/models/TenantBaseModel';
import {
  CryptoRecordSource,
  CryptoRecordType,
} from '../CryptoExchanges.constants';

export class CryptoRawRecord extends TenantBaseModel {
  id: number;
  connectionId: number;
  recordType: CryptoRecordType;
  exchangeRecordId: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
  payloadHash: string;
  /** Where the row came from: the exchange API or an imported CSV file. */
  source: CryptoRecordSource;
  /** The CSV import that created the row; null for API rows. */
  importId: number | null;
  createdAt?: Date;

  static get tableName() {
    return 'crypto_raw_records';
  }

  /** Append-only: no updated_at column. */
  get timestamps() {
    return [];
  }

  static get jsonAttributes() {
    return ['payload'];
  }
}
