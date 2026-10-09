import { parse } from 'csv-parse/sync';
import { CSV_LIMITS } from '../CryptoExchanges.constants';
import { CsvImportError, ReadCsvResult } from './csv.types';

interface ParsedEntry {
  record: string[];
  info: { bytes_records: number };
}

const LF = 0x0a;

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
    }) as unknown as ParsedEntry[];
  } catch (error) {
    const code = (error as { code?: string }).code;
    throw new CsvImportError(
      'CSV_MALFORMED',
      code === 'CSV_QUOTE_NOT_CLOSED'
        ? 'CSV contains an unterminated quoted field'
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
  assertCellLengths(entries[0].record);

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
    const cells: Record<string, string> = {};
    headers.forEach((h, idx) => {
      cells[h] = record[idx];
    });
    rows.push({ line, cells });
  }

  return { headers, rows, rejected };
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
