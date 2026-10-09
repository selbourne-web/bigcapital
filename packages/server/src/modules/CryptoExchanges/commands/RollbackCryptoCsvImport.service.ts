import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { AuditLogService } from '@/modules/EE/AuditLogs/AuditLog.service';
import { AbilitySubject } from '@/modules/Roles/Roles.types';
import { cryptoEvents } from '../CryptoExchanges.events';
import { CsvImportError } from '../csv/csv.types';
import { CsvImportView } from '../csv/csvImport.types';
import { CryptoCsvImportRepository } from './CryptoCsvImport.repository';
import { importNotFound, toCsvImportView } from './CryptoCsvImportView';
import { emitConnectionEvent } from './emitConnectionEvent';

@Injectable()
export class RollbackCryptoCsvImportService {
  constructor(
    private readonly imports: CryptoCsvImportRepository,
    private readonly auditLog: AuditLogService,
    private readonly eventEmitter: EventEmitter2,
    private readonly cls: ClsService,
  ) {}

  /**
   * Removes exactly the CSV rows stamped with this import. Rows that were
   * skipped as duplicates of an earlier import or of the API carry another
   * origin and stay.
   */
  async execute(importId: number): Promise<CsvImportView> {
    const preview = await this.imports.findImport(importId);
    if (!preview) throw importNotFound();

    return this.imports.inTransaction(async (trx) => {
      // FIRST statement: serialises imports per connection (see commit).
      if (!(await this.imports.lockConnection(preview.connectionId, trx))) {
        throw importNotFound();
      }
      const locked = await this.imports.findImport(importId, trx, true);
      if (!locked) throw importNotFound();
      if (locked.status !== 'committed') {
        throw new CsvImportError(
          'CSV_NOT_ROLLBACKABLE',
          'Only a committed import can be rolled back.',
          { status: locked.status },
        );
      }
      const dependents = await this.imports.findDependentImports(locked, trx);
      if (dependents.length) {
        const ids = dependents.map((d) => d.id);
        throw new CsvImportError(
          'CSV_NOT_ROLLBACKABLE',
          `Roll back the later import(s) first (${ids.join(', ')}): they skipped rows that this import wrote.`,
          { status: locked.status, dependentImportIds: ids },
        );
      }
      const removed = await this.imports.deleteRawByImport(importId, trx);
      await this.imports.patchImport(importId, { status: 'rolled_back' }, trx);
      await this.auditLog.record({
        trx,
        action: 'csv_rolled_back',
        subject: AbilitySubject.CryptoExchange,
        subjectId: locked.connectionId,
        metadata: {
          importId,
          exchange: locked.exchange,
          reportType: locked.reportType,
          rowsImported: locked.rowsImported,
          rowsRemoved: removed,
        },
      });
      await emitConnectionEvent(
        this.eventEmitter,
        this.cls,
        cryptoEvents.csvImport.rolledBack,
        locked.connectionId,
        trx,
      );
      return toCsvImportView((await this.imports.findImport(importId, trx))!);
    });
  }
}
