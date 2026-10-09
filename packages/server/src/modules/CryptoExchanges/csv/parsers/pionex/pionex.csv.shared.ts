import { isDecimal } from '../../../adapters/shared';
import { CsvParser, CsvRowResult } from '../../csv.types';
import { CryptoRecordType } from '../../../CryptoExchanges.constants';

export const DERIVED_EXPORT_REFUSE_REASON =
  'Derived export in a third-party format; import the original Pionex reports instead.';

export const DATE_COL = 'date(UTC+0)';

const DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3})\d*)?$/;

/** Parses `YYYY-MM-DD HH:MM:SS` as UTC. Returns null when not a real instant. */
export function parseUtc(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const m = DATE_RE.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const ms = m[7] ? Number(m[7].padEnd(3, '0')) : 0;
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d ||
    date.getUTCHours() !== h ||
    date.getUTCMinutes() !== mi ||
    date.getUTCSeconds() !== s
  ) {
    return null;
  }
  return date;
}

export const isSignedDecimal = (v: unknown): v is string =>
  typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v);

export const isPositiveDecimal = (v: unknown): boolean =>
  isDecimal(v) && /[1-9]/.test(v);

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

/** Splits on the first `_`; futures keep the quote before the PERP suffix. */
export function splitSymbol(symbol: string): {
  normalizedBase: string;
  normalizedQuote: string;
} {
  const i = symbol.indexOf('_');
  if (i <= 0) return { normalizedBase: symbol, normalizedQuote: '' };
  const rest = symbol.slice(i + 1);
  const j = rest.indexOf('_');
  return {
    normalizedBase: symbol.slice(0, i),
    normalizedQuote: j === -1 ? rest : rest.slice(0, j),
  };
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

export function importParser(
  reportType: string,
  headers: readonly string[],
  parseRow: CsvParser['parseRow'],
): CsvParser {
  return {
    id: `pionex:${reportType}`,
    exchange: 'pionex',
    reportType,
    disposition: 'import',
    matches: (h) => sameHeaders(h, headers),
    parseRow,
  };
}

export function refuseParser(
  reportType: string,
  headers: readonly string[],
): CsvParser {
  return {
    id: `pionex:${reportType}`,
    exchange: 'pionex',
    reportType,
    disposition: 'refuse',
    refuseReason: DERIVED_EXPORT_REFUSE_REASON,
    matches: (h) => sameHeaders(h, headers),
    parseRow: () => reject(DERIVED_EXPORT_REFUSE_REASON),
  };
}

export function dateOrReject(
  row: Record<string, string>,
  column = DATE_COL,
): Date | CsvRowResult {
  const d = parseUtc(row[column]);
  return d ?? reject(`Invalid date in column ${column}`);
}

export const isReject = (v: Date | CsvRowResult): v is CsvRowResult =>
  !(v instanceof Date);
