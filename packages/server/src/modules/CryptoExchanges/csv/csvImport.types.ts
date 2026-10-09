import {
  CryptoExchangeId,
  CsvImportStatus,
} from '../CryptoExchanges.constants';

/** Injection token for the `CsvParserRegistry` built from every exchange's parsers. */
export const CSV_PARSER_REGISTRY = 'CRYPTO_CSV_PARSER_REGISTRY';

/** How many rejected rows a preview lists; `rejectedCount` always has the full number. */
export const CSV_PREVIEW_REJECTED_LIMIT = 50;
/** Raw records written per INSERT statement on commit. */
export const CSV_INSERT_BATCH = 500;
/** Max JSON payload bytes per INSERT statement (well under max_allowed_packet). */
export const CSV_INSERT_MAX_BYTES = 4 * 1024 * 1024;
/** Ids per `WHERE ... IN (...)` lookup. */
export const CSV_LOOKUP_CHUNK = 1_000;
/** Rows removed per DELETE statement on rollback. */
export const CSV_DELETE_CHUNK = 5_000;
/** `previewed` imports older than this are abandoned and removed. */
export const CSV_PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;

export interface CsvImportPreview {
  importId: number;
  connectionId: number;
  exchange: CryptoExchangeId;
  reportType: string;
  filename: string;
  fileSha256: string;
  /** Data rows in the file (including rejected ones). */
  rowCount: number;
  /** Rows that would be written now: parsed, valid and not already stored. */
  importable: number;
  /** Parsed, valid rows whose id is already stored for this connection. */
  alreadyImported: number;
  rejectedCount: number;
  /** First 50 rejected rows. */
  rejected: Array<{ line: number; reason: string }>;
  /** Valid parsed rows by record type (including ones already stored). */
  byType: Record<string, number>;
  /** Min / max occurredAt of the valid parsed rows (ISO), null when none. */
  dateFrom: string | null;
  dateTo: string | null;
  /** API `trade` records already stored for the connection inside [dateFrom, dateTo]. */
  apiOverlap: number;
}

export interface CsvImportView {
  id: number;
  connectionId: number;
  reportType: string;
  filename: string;
  rowCount: number;
  rowsImported: number;
  rowsSkippedDuplicate: number;
  rowsRejected: number;
  dateFrom: string | null;
  dateTo: string | null;
  status: CsvImportStatus;
  createdAt: string;
  committedAt: string | null;
}

/** A parsed, id-assigned row ready to store. */
export interface CsvPlannedRecord {
  exchangeRecordId: string;
  record: {
    recordType: string;
    occurredAt: Date;
    payload: Record<string, unknown>;
  };
}

/** Everything derived from the file bytes; preview and commit share it. */
export interface CsvImportPlan {
  parserId: string;
  reportType: string;
  fileSha256: string;
  rowCount: number;
  records: CsvPlannedRecord[];
  rejected: Array<{ line: number; reason: string }>;
  byType: Record<string, number>;
  dateFrom: Date | null;
  dateTo: Date | null;
}
