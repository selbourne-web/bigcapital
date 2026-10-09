import { TenantBaseModel } from '@/modules/System/models/TenantBaseModel';
import {
  CryptoExchangeId,
  CsvImportStatus,
} from '../CryptoExchanges.constants';

/**
 * One uploaded CSV file on a connection. The file itself is never stored; the
 * row keeps its sha256 so the same committed file cannot be imported twice
 * (enforced in service logic, not by a DB unique, so a rolled-back file can be
 * imported again).
 */
export class CryptoCsvImport extends TenantBaseModel {
  id: number;
  connectionId: number;
  exchange: CryptoExchangeId;
  reportType: string;
  /** Display only: sanitized, never used as a path. */
  originalFilename: string;
  fileSha256: string;
  rowCount: number;
  rowsImported: number;
  rowsSkippedDuplicate: number;
  rowsRejected: number;
  dateFrom?: Date | null;
  dateTo?: Date | null;
  status: CsvImportStatus;
  error?: string | null;
  createdAt?: Date;
  committedAt?: Date | null;
  uploadedBy?: number | null;

  static get tableName() {
    return 'crypto_csv_imports';
  }

  /** No updated_at column. */
  get timestamps() {
    return [];
  }
}
