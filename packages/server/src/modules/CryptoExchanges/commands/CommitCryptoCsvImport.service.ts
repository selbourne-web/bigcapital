import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ServiceError } from '@/modules/Items/ServiceError';
import { cryptoEvents } from '../CryptoExchanges.events';
import { CsvImportError } from '../csv/csv.types';
import {
  CSV_INSERT_BATCH,
  CsvImportView,
  CsvPlannedRecord,
} from '../csv/csvImport.types';
import { CsvImportService, sha256Hex } from '../csv/CsvImport.service';
import { computePayloadHash, serializePayload } from '../utils/payloadHash';
import { CryptoConnectionRepository } from './CryptoConnection.repository';
import {
  CryptoCsvImportRepository,
  CsvRawRow,
} from './CryptoCsvImport.repository';
import {
  connectionNotFound,
  importNotFound,
  toCsvImportView,
} from './CryptoCsvImportView';
import { emitConnectionEvent } from './emitConnectionEvent';

@Injectable()
export class CommitCryptoCsvImportService {
  constructor(
    private readonly connections: CryptoConnectionRepository,
    private readonly imports: CryptoCsvImportRepository,
    private readonly csv: CsvImportService,
    private readonly eventEmitter: EventEmitter2,
    private readonly cls: ClsService,
  ) {}

  protected now(): Date {
    return new Date();
  }

  /**
   * Re-parses the re-sent file and writes its records, all or nothing. Rows
   * whose key already exists (an earlier import or the API) are skipped and
   * counted, never overwritten, and are not stamped with this import so a
   * rollback of this import cannot remove them.
   */
  async execute(
    importId: number,
    file: { buffer: Buffer },
  ): Promise<CsvImportView> {
    const preview = await this.imports.findImport(importId);
    if (!preview) throw importNotFound();
    this.assertCommittable(preview.status);

    const connection = await this.connections.findById(preview.connectionId);
    if (!connection) throw connectionNotFound();

    if (sha256Hex(file.buffer) !== preview.fileSha256) {
      throw new CsvImportError(
        'CSV_FILE_CHANGED',
        'The file differs from the one that was previewed. Upload and preview it again.',
      );
    }
    const plan = this.csv.plan(connection.exchange, file.buffer);
    if (plan.reportType !== preview.reportType) {
      throw new CsvImportError(
        'CSV_FILE_CHANGED',
        'The file no longer matches the previewed report type.',
      );
    }

    try {
      return await this.imports.inTransaction(async (trx) => {
        // Serializes concurrent commits of the same import.
        const locked = await this.imports.findImport(importId, trx, true);
        if (!locked) throw importNotFound();
        this.assertCommittable(locked.status);
        if (
          await this.imports.findCommittedByHash(
            locked.connectionId,
            locked.fileSha256,
            trx,
            locked.id,
          )
        ) {
          throw new CsvImportError(
            'CSV_DUPLICATE_FILE',
            'This file has already been imported for this connection.',
          );
        }
        if (!(await this.connections.findById(locked.connectionId, trx))) {
          throw connectionNotFound();
        }

        let inserted = 0;
        for (let i = 0; i < plan.records.length; i += CSV_INSERT_BATCH) {
          const batch = plan.records.slice(i, i + CSV_INSERT_BATCH);
          inserted += await this.imports.insertIgnoringDuplicates(
            batch.map((r) => this.toRow(locked.connectionId, importId, r)),
            trx,
          );
        }

        await this.verifyOutcome(
          locked.connectionId,
          importId,
          plan.records,
          inserted,
          trx,
        );

        await this.imports.patchImport(
          importId,
          {
            rowCount: plan.rowCount,
            rowsImported: inserted,
            rowsSkippedDuplicate: plan.records.length - inserted,
            rowsRejected: plan.rejected.length,
            dateFrom: plan.dateFrom,
            dateTo: plan.dateTo,
            status: 'committed',
            committedAt: this.now(),
            error: null,
          },
          trx,
        );
        await emitConnectionEvent(
          this.eventEmitter,
          this.cls,
          cryptoEvents.csvImport.committed,
          locked.connectionId,
          trx,
        );
        return toCsvImportView((await this.imports.findImport(importId, trx))!);
      });
    } catch (error) {
      if (!(error instanceof CsvImportError || error instanceof ServiceError)) {
        await this.imports
          .markFailed(importId, 'Import failed and was rolled back.')
          .catch(() => undefined);
      }
      throw error;
    }
  }

  private assertCommittable(status: string): void {
    if (status !== 'previewed') {
      throw new CsvImportError(
        'CSV_NOT_COMMITTABLE',
        'Only a previewed import can be committed.',
        { status },
      );
    }
  }

  private toRow(
    connectionId: number,
    importId: number,
    { exchangeRecordId, record }: CsvPlannedRecord,
  ): CsvRawRow {
    return {
      connectionId,
      recordType: record.recordType,
      exchangeRecordId,
      occurredAt: record.occurredAt,
      payload: serializePayload(record.payload),
      payloadHash: computePayloadHash(record.payload),
      source: 'csv',
      importId,
    };
  }

  /**
   * INSERT IGNORE also swallows non-duplicate row errors, so confirm that every
   * planned key is stored and that the rows stamped with this import match the
   * inserted count. A mismatch aborts (and rolls back) the whole commit.
   */
  private async verifyOutcome(
    connectionId: number,
    importId: number,
    records: CsvPlannedRecord[],
    inserted: number,
    trx: any,
  ): Promise<void> {
    const idsByType = new Map<string, string[]>();
    for (const { exchangeRecordId, record } of records) {
      const ids = idsByType.get(record.recordType) ?? [];
      ids.push(exchangeRecordId);
      idsByType.set(record.recordType, ids);
    }
    for (const [recordType, ids] of idsByType) {
      const present = await this.imports.countPresent(
        connectionId,
        recordType,
        ids,
        trx,
      );
      if (present !== ids.length) {
        throw new Error('CSV import verification failed: records missing');
      }
    }
    if ((await this.imports.countByImport(importId, trx)) !== inserted) {
      throw new Error('CSV import verification failed: count mismatch');
    }
  }
}
