import { ServiceError } from '@/modules/Items/ServiceError';
import { CryptoCsvImport } from '../models/CryptoCsvImport';
import {
  CRYPTO_CONNECTION_ERRORS,
  CRYPTO_CSV_IMPORT_ERRORS,
} from '../CryptoExchanges.constants';
import { CsvImportView } from '../csv/csvImport.types';

const iso = (value?: Date | string | null): string | null =>
  value ? new Date(value).toISOString() : null;

/** Allow-list view: never exposes `error`, `fileSha256` or `uploadedBy`. */
export const toCsvImportView = (row: CryptoCsvImport): CsvImportView => ({
  id: row.id,
  connectionId: row.connectionId,
  reportType: row.reportType,
  filename: row.originalFilename,
  rowCount: row.rowCount,
  rowsImported: row.rowsImported,
  rowsSkippedDuplicate: row.rowsSkippedDuplicate,
  rowsRejected: row.rowsRejected,
  dateFrom: iso(row.dateFrom),
  dateTo: iso(row.dateTo),
  status: row.status,
  createdAt: iso(row.createdAt) as string,
  committedAt: iso(row.committedAt),
});

export const connectionNotFound = () =>
  new ServiceError(
    CRYPTO_CONNECTION_ERRORS.NOT_FOUND,
    'Crypto connection not found.',
    undefined,
    404,
  );

export const importNotFound = () =>
  new ServiceError(
    CRYPTO_CSV_IMPORT_ERRORS.NOT_FOUND,
    'CSV import not found.',
    undefined,
    404,
  );
