import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { Knex } from 'knex';
import { ServiceError } from '@/modules/Items/ServiceError';
import { UnitOfWork } from '@/modules/Tenancy/TenancyDB/UnitOfWork.service';
import { AuditLogService } from '@/modules/EE/AuditLogs/AuditLog.service';
import { AbilitySubject } from '@/modules/Roles/Roles.types';
import { CryptoVault } from '../vault/CryptoVault.service';
import { RotateCredentialsDto } from '../dtos/RotateCredentials.dto';
import { CRYPTO_CONNECTION_ERRORS as ERRORS } from '../CryptoExchanges.constants';
import { cryptoEvents } from '../CryptoExchanges.events';
import { CryptoConnectionRepository } from './CryptoConnection.repository';
import { CryptoConnectionValidators } from './CryptoConnectionValidators.service';
import { CryptoConnectionView, toConnectionView } from './CryptoConnectionView';
import { emitConnectionEvent } from './emitConnectionEvent';
import { assertApiMode } from './assertApiMode';

@Injectable()
export class RotateCryptoCredentialsService {
  constructor(
    private readonly connections: CryptoConnectionRepository,
    private readonly vault: CryptoVault,
    private readonly validators: CryptoConnectionValidators,
    private readonly uow: UnitOfWork,
    private readonly auditLog: AuditLogService,
    private readonly eventEmitter: EventEmitter2,
    private readonly cls: ClsService,
  ) {}

  /**
   * Replaces the credentials after re-running the read-only inspection on the
   * NEW key (same extra-permission and attestation rules as create). Any
   * failure leaves the stored credentials untouched; success reactivates the
   * connection and clears its last error.
   */
  async execute(
    id: number,
    dto: RotateCredentialsDto,
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
    // Also the Reconnect action (the webapp reconnects through this endpoint).
    assertApiMode(connection);
    const { credentials, inspection } =
      await this.validators.verifyCredentialsDetailed(
        connection.exchange,
        dto,
        dto.attestReadOnly,
      );
    const apiKey = this.vault.encrypt(credentials.apiKey);
    const apiSecret = this.vault.encrypt(credentials.apiSecret);
    const passphrase = credentials.passphrase
      ? this.vault.encrypt(credentials.passphrase)
      : null;
    const keyHint = credentials.apiKey.slice(-4);

    return this.uow.withTransaction(async (trx: Knex.Transaction) => {
      const updated = await this.connections.patch(
        id,
        {
          apiKeyEncrypted: apiKey.value,
          apiSecretEncrypted: apiSecret.value,
          passphraseEncrypted: passphrase?.value ?? null,
          keyVersion: apiKey.keyVersion,
          keyHint,
          keyExpiresAt: inspection.expiresAt ?? null,
          status: 'active',
          lastError: null,
        },
        trx,
      );
      await this.auditLog.record({
        trx,
        action: 'credentials_rotated',
        subject: AbilitySubject.CryptoExchange,
        subjectId: id,
        metadata: {
          exchange: connection.exchange,
          previousKeyHint: connection.keyHint ?? null,
          keyHint,
          previousStatus: connection.status,
        },
      });
      await emitConnectionEvent(
        this.eventEmitter,
        this.cls,
        cryptoEvents.connection.credentialsRotated,
        id,
        trx,
      );
      return toConnectionView(updated);
    });
  }
}
