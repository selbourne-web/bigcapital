import {
  CryptoExchangeId,
  CryptoRecordType,
} from '../CryptoExchanges.constants';

/** Non-enumerable key on `cells` objects from readCsv: headers in file order. */
export const CSV_HEADER_ORDER: unique symbol = Symbol('csvHeaderOrder');

export interface CsvRecordInput {
  recordType: CryptoRecordType;
  occurredAt: Date;
  payload: Record<string, unknown>;
}

export type CsvRowResult =
  | { kind: 'record'; record: CsvRecordInput }
  | { kind: 'reject'; reason: string };

export interface CsvParser {
  readonly id: string; // e.g. 'pionex:raw-trading-details'
  readonly exchange: CryptoExchangeId;
  readonly reportType: string;
  readonly disposition: 'import' | 'refuse';
  readonly refuseReason?: string; // required when disposition === 'refuse'
  /** Exact header signature after trim/BOM strip. */
  matches(headers: string[]): boolean;
  parseRow(row: Record<string, string>, ctx: { line: number }): CsvRowResult;
}

export interface ReadCsvResult {
  headers: string[];
  rows: Array<{ line: number; cells: Record<string, string> }>;
  rejected: Array<{ line: number; reason: string }>;
}

export type CsvErrorCode =
  | 'CSV_FORMAT_UNRECOGNIZED'
  | 'CSV_DERIVED_EXPORT_REFUSED'
  | 'CSV_DUPLICATE_FILE'
  | 'CSV_TOO_LARGE'
  | 'CSV_FILE_CHANGED'
  | 'CSV_NOT_ROLLBACKABLE'
  | 'CSV_NOT_COMMITTABLE'
  | 'CSV_MALFORMED';

export class CsvImportError extends Error {
  constructor(
    readonly code: CsvErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CsvImportError';
    Object.setPrototypeOf(this, CsvImportError.prototype);
  }
}
