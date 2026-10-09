import { Injectable } from '@nestjs/common';
import { CsvImportError } from '../csv/csv.types';
import {
  CSV_PREVIEW_REJECTED_LIMIT,
  CSV_PREVIEW_TTL_MS,
  CsvImportPreview,
} from '../csv/csvImport.types';
import {
  CsvImportService,
  sanitizeFilename,
  sha256Hex,
} from '../csv/CsvImport.service';
import { CryptoConnectionRepository } from './CryptoConnection.repository';
import { CryptoCsvImportRepository } from './CryptoCsvImport.repository';
import { connectionNotFound } from './CryptoCsvImportView';

@Injectable()
export class PreviewCryptoCsvImportService {
  constructor(
    private readonly connections: CryptoConnectionRepository,
    private readonly imports: CryptoCsvImportRepository,
    private readonly csv: CsvImportService,
  ) {}

  protected now(): Date {
    return new Date();
  }

  /**
   * Parses the file and records a `previewed` import. Nothing is written to
   * `crypto_raw_records`; the counts say what a commit of these bytes would do.
   */
  async execute(
    connectionId: number,
    file: { buffer: Buffer; originalname: string },
    userId: number,
  ): Promise<CsvImportPreview> {
    const connection = await this.connections.findById(connectionId);
    if (!connection) throw connectionNotFound();

    const fileSha256 = sha256Hex(file.buffer);
    if (await this.imports.findCommittedByHash(connectionId, fileSha256)) {
      throw new CsvImportError(
        'CSV_DUPLICATE_FILE',
        'This file has already been imported for this connection.',
      );
    }

    // Throws CSV_* errors before any row is created.
    const plan = this.csv.plan(connection.exchange, file.buffer);

    await this.imports.deleteStalePreviews(
      connectionId,
      new Date(this.now().getTime() - CSV_PREVIEW_TTL_MS),
    );

    const idsByType = new Map<string, string[]>();
    for (const { exchangeRecordId, record } of plan.records) {
      const ids = idsByType.get(record.recordType) ?? [];
      ids.push(exchangeRecordId);
      idsByType.set(record.recordType, ids);
    }
    let alreadyImported = 0;
    for (const [recordType, ids] of idsByType) {
      const existing = await this.imports.findExistingIds(
        connectionId,
        recordType,
        ids,
      );
      alreadyImported += existing.size;
    }

    const apiOverlap =
      plan.dateFrom && plan.dateTo
        ? await this.imports.countApiTrades(
            connectionId,
            plan.dateFrom,
            plan.dateTo,
          )
        : 0;

    const filename = sanitizeFilename(file.originalname);
    const row = await this.imports.insertImport({
      connectionId,
      exchange: connection.exchange,
      reportType: plan.reportType,
      originalFilename: filename,
      fileSha256,
      rowCount: plan.rowCount,
      rowsRejected: plan.rejected.length,
      dateFrom: plan.dateFrom,
      dateTo: plan.dateTo,
      status: 'previewed',
      createdAt: this.now(),
      uploadedBy: userId ?? null,
    });

    return {
      importId: row.id,
      connectionId,
      exchange: connection.exchange,
      reportType: plan.reportType,
      filename,
      fileSha256,
      rowCount: plan.rowCount,
      importable: plan.records.length - alreadyImported,
      alreadyImported,
      rejectedCount: plan.rejected.length,
      rejected: plan.rejected.slice(0, CSV_PREVIEW_REJECTED_LIMIT),
      byType: plan.byType,
      dateFrom: plan.dateFrom ? plan.dateFrom.toISOString() : null,
      dateTo: plan.dateTo ? plan.dateTo.toISOString() : null,
      apiOverlap,
    };
  }
}
