import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { Knex } from 'knex';
import { ServiceError } from '@/modules/Items/ServiceError';
import { UnitOfWork } from '@/modules/Tenancy/TenancyDB/UnitOfWork.service';
import { AuditLogService } from '@/modules/EE/AuditLogs/AuditLog.service';
import { AbilitySubject } from '@/modules/Roles/Roles.types';
import { CRYPTO_CONNECTION_ERRORS as ERRORS } from '../CryptoExchanges.constants';
import { cryptoEvents } from '../CryptoExchanges.events';
import { CryptoConnectionRepository } from './CryptoConnection.repository';
import { emitConnectionEvent } from './emitConnectionEvent';

@Injectable()
export class DeleteCryptoConnectionService {
  constructor(
    private readonly connections: CryptoConnectionRepository,
    private readonly uow: UnitOfWork,
    private readonly auditLog: AuditLogService,
    private readonly eventEmitter: EventEmitter2,
    private readonly cls: ClsService,
  ) {}

  /**
   * Removes the connection and its credentials.
   *
   * Raw records, balance snapshots and sync runs are kept unless
   * `deleteData: true`. Those tables reference the connection with ON DELETE
   * CASCADE, so keeping them means keeping the connection row: the default path
   * archives it (credentials and account mapping wiped, status `paused`,
   * `deleted_at` set) and every connection query hides archived rows. Only
   * `deleteData: true` really deletes the row, cascading the data.
   */
  async execute(
    id: number,
    options: { deleteData?: boolean } = {},
  ): Promise<void> {
    const connection = await this.connections.findById(id);
    if (!connection) {
      throw new ServiceError(
        ERRORS.NOT_FOUND,
        'Crypto connection not found.',
        undefined,
        404,
      );
    }
    const deleteData = options.deleteData === true;

    await this.uow.withTransaction(async (trx: Knex.Transaction) => {
      if (deleteData) {
        await this.connections.hardDelete(id, trx);
      } else {
        await this.connections.archive(id, trx);
      }
      await this.auditLog.record({
        trx,
        action: 'deleted',
        subject: AbilitySubject.CryptoExchange,
        subjectId: id,
        metadata: {
          exchange: connection.exchange,
          label: connection.label,
          deleteData,
        },
      });
      await emitConnectionEvent(
        this.eventEmitter,
        this.cls,
        cryptoEvents.connection.deleted,
        id,
        trx,
      );
    });
  }
}
