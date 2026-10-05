import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { Knex } from 'knex';
import { ServiceError } from '@/modules/Items/ServiceError';
import { UnitOfWork } from '@/modules/Tenancy/TenancyDB/UnitOfWork.service';
import { AuditLogService } from '@/modules/EE/AuditLogs/AuditLog.service';
import { AbilitySubject } from '@/modules/Roles/Roles.types';
import { CryptoConnection } from '../models/CryptoConnection';
import { UpdateCryptoConnectionDto } from '../dtos/UpdateCryptoConnection.dto';
import { CRYPTO_CONNECTION_ERRORS as ERRORS } from '../CryptoExchanges.constants';
import { cryptoEvents } from '../CryptoExchanges.events';
import { CryptoConnectionRepository } from './CryptoConnection.repository';
import { CryptoConnectionValidators } from './CryptoConnectionValidators.service';
import { CryptoConnectionView, toConnectionView } from './CryptoConnectionView';
import { emitConnectionEvent } from './emitConnectionEvent';

@Injectable()
export class UpdateCryptoConnectionService {
  constructor(
    private readonly connections: CryptoConnectionRepository,
    private readonly validators: CryptoConnectionValidators,
    private readonly uow: UnitOfWork,
    private readonly auditLog: AuditLogService,
    private readonly eventEmitter: EventEmitter2,
    private readonly cls: ClsService,
  ) {}

  /**
   * Rename, pause (`status: 'paused'`), resume (`status: 'active'`) and
   * set/change/clear the mapped account.
   *
   * Resuming a connection in `error` status is refused: it errored because the
   * exchange rejected its credentials (or a key gained extra permissions), so
   * it only returns to `active` by rotating credentials. (A successful manual
   * sync also reactivates it; that is wired in the sync processor.)
   *
   * Changing the account is allowed in piece 1; blocking it once journal
   * entries are posted belongs to piece 3.
   */
  async execute(
    id: number,
    dto: UpdateCryptoConnectionDto,
  ): Promise<CryptoConnectionView> {
    const connection = await this.connections.findById(id);
    if (!connection) {
      throw new ServiceError(
        ERRORS.NOT_FOUND,
        'Crypto connection not found.',
        undefined,
        404,
      );
    }

    const patch: Partial<CryptoConnection> = {};
    const changes: Record<string, unknown> = {};
    let event: string | undefined;

    const label = dto.label?.trim();
    if (label !== undefined && label !== connection.label) {
      patch.label = label;
      changes.label = label;
    }

    if (dto.status && dto.status !== connection.status) {
      if (dto.status === 'paused') {
        patch.status = 'paused';
        event = cryptoEvents.connection.paused;
      } else {
        if (connection.status === 'error') {
          throw new ServiceError(
            ERRORS.IN_ERROR,
            'This connection has an error. Replace its credentials to reconnect.',
          );
        }
        patch.status = 'active';
        patch.lastError = null;
        event = cryptoEvents.connection.resumed;
      }
      changes.status = dto.status;
    }

    const accountChanged =
      dto.accountId !== undefined &&
      (dto.accountId ?? null) !== (connection.accountId ?? null);
    if (accountChanged) {
      patch.accountId = dto.accountId ?? null;
      changes.accountId = patch.accountId;
    }

    if (!Object.keys(patch).length) {
      return toConnectionView(connection);
    }

    return this.uow
      .withTransaction(async (trx: Knex.Transaction) => {
        if (accountChanged && patch.accountId != null) {
          await this.validators.validateAccountMapping(
            patch.accountId,
            trx,
            connection.id,
          );
        }
        const updated = await this.connections.patch(id, patch, trx);

        await this.auditLog.record({
          trx,
          action: 'edited',
          subject: AbilitySubject.CryptoExchange,
          subjectId: id,
          metadata: { exchange: connection.exchange, changes },
        });
        if (event) {
          await emitConnectionEvent(
            this.eventEmitter,
            this.cls,
            event,
            id,
            trx,
          );
        }
        return toConnectionView(updated);
      })
      .catch((error) => this.validators.rethrowIfDuplicateAccount(error));
  }
}
