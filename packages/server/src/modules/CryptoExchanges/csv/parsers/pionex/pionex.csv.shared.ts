import { isDecimal } from '../../../adapters/shared';
import { CsvParser, CsvRowResult } from '../../csv.types';
import {
  firstBadDecimal,
  importParser as importParserFor,
  isSignedDecimal,
  rawPayload,
  record,
  reject,
  safe,
  sameHeaders,
} from '../csv.shared';

// Generic helpers live in ../csv.shared; re-exported so Pionex imports are unchanged.
export {
  firstBadDecimal,
  isSignedDecimal,
  rawPayload,
  record,
  reject,
  safe,
  sameHeaders,
};

export function importParser(
  reportType: string,
  headers: readonly string[],
  parseRow: CsvParser['parseRow'],
): CsvParser {
  return importParserFor('pionex', reportType, headers, parseRow);
}

export const DERIVED_EXPORT_REFUSE_REASON =
  'Derived export in a third-party format; import the original Pionex reports instead.';

export const DATE_COL = 'date(UTC+0)';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/** Parses strict `YYYY-MM-DD HH:mm:ss` as UTC. Null when not a real instant. */
export function parseUtc(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const m = DATE_RE.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
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

export const isPositiveDecimal = (v: unknown): boolean =>
  isDecimal(v) && /[1-9]/.test(v);

const MAX_SYMBOL_LENGTH = 64;

/**
 * Splits on the first `_`; futures keep the quote before the PERP suffix.
 * Rejects (naming `symbol`) a missing, `_`-less, `_`-leading or over-long symbol.
 */
export function splitSymbol(
  symbol: unknown,
): { normalizedBase: string; normalizedQuote: string } | CsvRowResult {
  if (
    typeof symbol !== 'string' ||
    symbol.length > MAX_SYMBOL_LENGTH ||
    symbol.indexOf('_') <= 0
  ) {
    return reject('Invalid value in column symbol');
  }
  const i = symbol.indexOf('_');
  const rest = symbol.slice(i + 1);
  const j = rest.indexOf('_');
  const quote = j === -1 ? rest : rest.slice(0, j);
  if (!quote) return reject('Invalid value in column symbol');
  return { normalizedBase: symbol.slice(0, i), normalizedQuote: quote };
}

export const isSymbolReject = (
  v: ReturnType<typeof splitSymbol>,
): v is CsvRowResult => 'kind' in v;

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
