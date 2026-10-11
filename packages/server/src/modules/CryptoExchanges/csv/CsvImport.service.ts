import { createHash } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CryptoExchangeId, CSV_LIMITS } from '../CryptoExchanges.constants';
import { readCsv } from './CsvReader';
import { CsvParserRegistry } from './CsvParserRegistry';
import { assignCsvRecordIds } from './csvRecordId';
import { CsvRecordInput } from './csv.types';
import { CSV_PARSER_REGISTRY, CsvImportPlan } from './csvImport.types';

export const sha256Hex = (buffer: Buffer): string =>
  createHash('sha256').update(buffer).digest('hex');

/**
 * Display-only filename: path parts, control and bidi-override characters are
 * removed. The name is never used as a path.
 */
export function sanitizeFilename(name: unknown): string {
  const base = String(name ?? '')
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '')
    // The tenant schema is utf8 (3-byte): a 4-byte character (emoji, rare CJK)
    // would fail or corrupt the insert. Replaced before the length cut so a
    // surrogate pair is never split.
    .replace(/[\u{10000}-\u{10FFFF}]/gu, '_')
    .trim();
  return (base || 'upload.csv').slice(0, CSV_LIMITS.maxFilenameChars);
}

/**
 * Parse + id assignment + summary of one file. Preview and commit both call
 * this, so what the user previewed is what commit writes.
 *
 * Throws `CsvImportError` (CSV_TOO_LARGE, CSV_MALFORMED,
 * CSV_FORMAT_UNRECOGNIZED, CSV_DERIVED_EXPORT_REFUSED) unchanged.
 */
@Injectable()
export class CsvImportService {
  constructor(
    @Inject(CSV_PARSER_REGISTRY) private readonly registry: CsvParserRegistry,
  ) {}

  plan(exchange: CryptoExchangeId, buffer: Buffer): CsvImportPlan {
    const read = readCsv(buffer);
    const parser = this.registry.resolve(exchange, read.headers);

    const rejected = [...read.rejected];
    const parsed: Array<{
      cells: Record<string, string>;
      record: CsvRecordInput;
    }> = [];
    for (const row of read.rows) {
      let result;
      try {
        result = parser.parseRow(row.cells, { line: row.line });
      } catch {
        result = { kind: 'reject' as const, reason: 'Row could not be parsed' };
      }
      if (result.kind === 'reject') {
        rejected.push({ line: row.line, reason: result.reason });
      } else {
        // cells must reach assignCsvRecordIds untouched (never cloned).
        parsed.push({ cells: row.cells, record: result.record });
      }
    }
    rejected.sort((a, b) => a.line - b.line);

    const records = assignCsvRecordIds(parser.id, parsed, read.headers);

    const byType: Record<string, number> = {};
    let dateFrom: Date | null = null;
    let dateTo: Date | null = null;
    for (const { record } of records) {
      byType[record.recordType] = (byType[record.recordType] ?? 0) + 1;
      if (!dateFrom || record.occurredAt < dateFrom)
        dateFrom = record.occurredAt;
      if (!dateTo || record.occurredAt > dateTo) dateTo = record.occurredAt;
    }

    return {
      parserId: parser.id,
      reportType: parser.reportType,
      fileSha256: sha256Hex(buffer),
      rowCount: read.rows.length + read.rejected.length,
      records,
      rejected,
      byType,
      dateFrom,
      dateTo,
    };
  }
}
