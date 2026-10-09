import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
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
    private readonly eventEmitter: EventEmitter2,
    private readonly cls: ClsService,
  ) {}

  /**
   * Removes exactly the CSV rows stamped with this import. Rows that were
   * skipped as duplicates of an earlier import or of the API carry another
   * origin and stay.
   */
  async execute(importId: number): Promise<CsvImportView> {
    if (!(await this.imports.findImport(importId))) throw importNotFound();

    return this.imports.inTransaction(async (trx) => {
      const locked = await this.imports.findImport(importId, trx, true);
      if (!locked) throw importNotFound();
      if (locked.status !== 'committed') {
        throw new CsvImportError(
          'CSV_NOT_ROLLBACKABLE',
          'Only a committed import can be rolled back.',
          { status: locked.status },
        );
      }
      await this.imports.deleteRawByImport(importId, trx);
      await this.imports.patchImport(importId, { status: 'rolled_back' }, trx);
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
