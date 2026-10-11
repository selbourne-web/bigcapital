import { isDecimal } from '../../adapters/shared';
import { CsvParser, CsvRowResult } from '../csv.types';
import {
  CryptoExchangeId,
  CryptoRecordType,
} from '../../CryptoExchanges.constants';

/** Exchange-neutral helpers shared by every CSV parser module. */

export const isSignedDecimal = (v: unknown): v is string =>
  typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v);

export const reject = (reason: string): CsvRowResult => ({
  kind: 'reject',
  reason,
});

export const record = (
  recordType: CryptoRecordType,
  occurredAt: Date,
  payload: Record<string, unknown>,
): CsvRowResult => ({
  kind: 'record',
  record: { recordType, occurredAt, payload },
});

/** Every raw cell under its original header name, as a plain object. */
export const rawPayload = (
  row: Record<string, string>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({ ...row, ...extra, source: 'csv' });

export const sameHeaders = (a: string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((h, i) => h === b[i]);

/** First column whose value is not a decimal string, or null. */
export function firstBadDecimal(
  row: Record<string, string>,
  columns: readonly string[],
  signed = false,
): string | null {
  const ok = signed ? isSignedDecimal : isDecimal;
  return columns.find((c) => !ok(row[c])) ?? null;
}

/** Wraps a parseRow so an unexpected throw becomes a reject. */
export function safe(fn: CsvParser['parseRow']): CsvParser['parseRow'] {
  return (row, ctx) => {
    try {
      return fn(row, ctx);
    } catch {
      return reject('Row could not be parsed');
    }
  };
}

/** Import parser whose id is `<exchange>:<reportType>`. */
export function importParser(
  exchange: CryptoExchangeId,
  reportType: string,
  headers: readonly string[],
  parseRow: CsvParser['parseRow'],
): CsvParser {
  return {
    id: `${exchange}:${reportType}`,
    exchange,
    reportType,
    disposition: 'import',
    matches: (h) => sameHeaders(h, headers),
    parseRow,
  };
}
