import { parse } from 'csv-parse/sync';
import { CSV_LIMITS } from '../CryptoExchanges.constants';
import { CSV_HEADER_ORDER, CsvImportError, ReadCsvResult } from './csv.types';

interface ParsedEntry {
  record: string[];
  info: { bytes_records: number };
}

const LF = 0x0a;
const CR = 0x0d;
const RESERVED_HEADERS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Line numbers are LF-based, so UTF-16 input and lone-CR line endings are
 * refused (any CR not followed by LF, even inside a quoted cell).
 */
function assertSupportedEncoding(buffer: Buffer): void {
  const utf16 =
    buffer.length >= 2 &&
    ((buffer[0] === 0xff && buffer[1] === 0xfe) ||
      (buffer[0] === 0xfe && buffer[1] === 0xff));
  if (utf16) {
    throw new CsvImportError('CSV_MALFORMED', 'UTF-16 CSV is not supported');
  }
  for (let i = buffer.indexOf(CR); i !== -1; i = buffer.indexOf(CR, i + 1)) {
    if (buffer[i + 1] !== LF) {
      throw new CsvImportError(
        'CSV_MALFORMED',
        'CSV uses unsupported line endings (lone CR)',
      );
    }
  }
}

const QUOTE = 0x22;
const COMMA = 0x2c;

/**
 * Cheap single pass before csv-parse: no record may be larger than
 * `maxRecordBytes` or have more than `maxColumns` columns, so a 10 MB file of
 * commas cannot become ~10M empty cells. Quote state is tracked (an escaped
 * `""` toggles twice), so newlines and commas inside quoted cells do not count.
 * Reports no file content.
 */
function assertRecordShape(buffer: Buffer): void {
  let inQuotes = false;
  let commas = 0;
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    const b = buffer[i];
    if (b === QUOTE) {
      inQuotes = !inQuotes;
    } else if (!inQuotes) {
      if (b === COMMA) {
        if (++commas >= CSV_LIMITS.maxColumns) {
          throw new CsvImportError(
            'CSV_MALFORMED',
            `CSV has a record with more than ${CSV_LIMITS.maxColumns} columns`,
          );
        }
      } else if (b === LF) {
        commas = 0;
        start = i + 1;
      }
    }
    if (i - start >= CSV_LIMITS.maxRecordBytes && !inQuotes) {
      throw new CsvImportError(
        'CSV_MALFORMED',
        `CSV has a record larger than ${CSV_LIMITS.maxRecordBytes} bytes`,
      );
    }
  }
}

/**
 * Bounded, synchronous CSV reader. The buffer is already capped in memory by
 * the caller; the byte cap is still checked first, before any parsing.
 * Cell text is data: it is returned verbatim (never trimmed or evaluated).
 * Only header names are trimmed.
 */
export function readCsv(buffer: Buffer): ReadCsvResult {
  if (buffer.length > CSV_LIMITS.maxBytes) {
    throw new CsvImportError(
      'CSV_TOO_LARGE',
      `CSV file exceeds ${CSV_LIMITS.maxBytes} bytes`,
    );
  }

  assertSupportedEncoding(buffer);
  assertRecordShape(buffer);

  let entries: ParsedEntry[];
  try {
    entries = parse(buffer, {
      bom: true,
      // Column-count mismatches are reported per row below rather than
      // aborting the whole file.
      relax_column_count: true,
      skip_empty_lines: true,
      trim: false,
      info: true,
      // header record + maxRows data rows + one extra to detect overflow
      to: CSV_LIMITS.maxRows + 2,
      // Backstop for the parser's own buffer (it counts field text only, not
      // delimiters; assertRecordShape bounds those before parsing).
      max_record_size: CSV_LIMITS.maxRecordBytes,
    }) as unknown as ParsedEntry[];
  } catch (error) {
    const code = (error as { code?: string }).code;
    throw new CsvImportError(
      'CSV_MALFORMED',
      code === 'CSV_QUOTE_NOT_CLOSED'
        ? 'CSV contains an unterminated quoted field'
        : code === 'CSV_MAX_RECORD_SIZE'
          ? `CSV has a record larger than ${CSV_LIMITS.maxRecordBytes} bytes`
          : 'CSV could not be parsed',
      { parserCode: code },
    );
  }

  if (entries.length === 0) {
    throw new CsvImportError('CSV_MALFORMED', 'CSV file is empty');
  }
  if (entries.length - 1 > CSV_LIMITS.maxRows) {
    throw new CsvImportError(
      'CSV_TOO_LARGE',
      `CSV file exceeds ${CSV_LIMITS.maxRows} rows`,
    );
  }

  const headers = entries[0].record.map((h) => h.trim());
  if (new Set(headers).size !== headers.length) {
    throw new CsvImportError('CSV_MALFORMED', 'CSV header has duplicate names');
  }
  const reserved = headers.find((h) => RESERVED_HEADERS.has(h));
  if (reserved !== undefined) {
    throw new CsvImportError(
      'CSV_MALFORMED',
      `CSV header name "${reserved}" is not allowed`,
    );
  }
  assertCellLengths(entries[0].record);
  assertNoAstral(entries[0].record, 1);

  const rows: ReadCsvResult['rows'] = [];
  const rejected: ReadCsvResult['rejected'] = [];

  // Physical-line tracking: a record's last line = newlines consumed up to the
  // end of the record; its first line subtracts newlines inside quoted cells.
  let scanned = 0;
  let newlines = 0;
  const lastLineAt = (endOffset: number): number => {
    const end = Math.min(endOffset, buffer.length);
    for (; scanned < end; scanned++) {
      if (buffer[scanned] === LF) newlines++;
    }
    return newlines + (end > 0 && buffer[end - 1] === LF ? 0 : 1);
  };

  for (let i = 1; i < entries.length; i++) {
    const { record, info } = entries[i];
    assertCellLengths(record);
    let inner = 0;
    for (const cell of record) {
      for (
        let k = cell.indexOf('\n');
        k !== -1;
        k = cell.indexOf('\n', k + 1)
      ) {
        inner++;
      }
    }
    const line = lastLineAt(info.bytes_records) - inner;

    if (record.length !== headers.length) {
      rejected.push({
        line,
        reason: `Expected ${headers.length} columns but found ${record.length}`,
      });
      continue;
    }
    assertNoAstral(record, line);
    const cells: Record<string, string> = {};
    headers.forEach((h, idx) => {
      cells[h] = record[idx];
    });
    // Header order for record ids (integer-like keys would otherwise be
    // enumerated first). Non-enumerable so it never leaks into comparisons.
    Object.defineProperty(cells, CSV_HEADER_ORDER, { value: headers });
    rows.push({ line, cells });
  }

  return { headers, rows, rejected };
}

const ASTRAL = /[\u{10000}-\u{10FFFF}]/u;

/**
 * The tenant schema is utf8 (3-byte). A 4-byte character (emoji, rare CJK) in
 * stored data makes MariaDB drop or reject it, and the commit's warning check
 * would then abort with a generic error. Refusing the file at preview names the
 * line instead. The file is refused rather than escaped so record ids and
 * payload hashes (derived from the exact cell text) are never altered; ids can
 * also come straight from a cell, which escaping the payload would not cover.
 * Only the line number is reported, never cell content.
 */
function assertNoAstral(record: string[], line: number): void {
  for (const cell of record) {
    if (ASTRAL.test(cell)) {
      throw new CsvImportError(
        'CSV_MALFORMED',
        `CSV line ${line} contains a character (such as an emoji) that cannot be stored. Remove it and upload the file again.`,
      );
    }
  }
}

function assertCellLengths(record: string[]): void {
  for (const cell of record) {
    if (cell.length > CSV_LIMITS.maxCellChars) {
      throw new CsvImportError(
        'CSV_MALFORMED',
        `CSV cell exceeds ${CSV_LIMITS.maxCellChars} characters`,
      );
    }
  }
}
