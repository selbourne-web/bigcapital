import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { Knex } from 'knex';
import { ServiceError } from '@/modules/Items/ServiceError';
import { UnitOfWork } from '@/modules/Tenancy/TenancyDB/UnitOfWork.service';
import { CreateAccountService } from '@/modules/Accounts/CreateAccount.service';
import { AuditLogService } from '@/modules/EE/AuditLogs/AuditLog.service';
import { AbilitySubject } from '@/modules/Roles/Roles.types';
import { CryptoVault } from '../vault/CryptoVault.service';
import { CreateCryptoConnectionDto } from '../dtos/CreateCryptoConnection.dto';
import {
  CRYPTO_ACCOUNT_TYPE,
  CRYPTO_CONNECTION_ERRORS as ERRORS,
  CryptoExchangeId,
} from '../CryptoExchanges.constants';
import { cryptoEvents } from '../CryptoExchanges.events';
import { CryptoConnectionRepository } from './CryptoConnection.repository';
import { CryptoConnectionValidators } from './CryptoConnectionValidators.service';
import { CryptoConnectionView, toConnectionView } from './CryptoConnectionView';
import { emitConnectionEvent } from './emitConnectionEvent';

@Injectable()
export class CreateCryptoConnectionService {
  constructor(
    private readonly connections: CryptoConnectionRepository,
    private readonly vault: CryptoVault,
    private readonly validators: CryptoConnectionValidators,
    private readonly uow: UnitOfWork,
    private readonly createAccountService: CreateAccountService,
    private readonly auditLog: AuditLogService,
    private readonly eventEmitter: EventEmitter2,
    private readonly cls: ClsService,
  ) {}

  /**
   * Verifies the key is read-only, then stores the encrypted credentials and,
   * optionally, maps (or creates) the asset account, all in one transaction.
   */
  async execute(dto: CreateCryptoConnectionDto): Promise<CryptoConnectionView> {
    const label = dto.label?.trim();
    if (!label) {
      throw new ServiceError(
        ERRORS.CREDENTIALS_REQUIRED,
        'A label is required.',
      );
    }
    this.validators.assertSupportedExchange(dto.exchange);
    const exchange: CryptoExchangeId = dto.exchange;

    if (dto.accountId != null && dto.createAccount === true) {
      throw new ServiceError(
        ERRORS.ACCOUNT_MAPPING_CONFLICT,
        'Choose either an existing account or create a new one, not both.',
      );
    }

    // Network call to the exchange happens before any transaction is opened.
    const credentials = await this.validators.verifyCredentials(
      exchange,
      dto,
      dto.attestReadOnly,
    );
    const apiKey = this.vault.encrypt(credentials.apiKey);
    const apiSecret = this.vault.encrypt(credentials.apiSecret);
    const passphrase = credentials.passphrase
      ? this.vault.encrypt(credentials.passphrase)
      : null;
    const keyHint = credentials.apiKey.slice(-4);

    return this.uow
      .withTransaction(async (trx: Knex.Transaction) => {
        let accountId: number | null = null;
        if (dto.accountId != null) {
          await this.validators.validateAccountMapping(dto.accountId, trx);
          accountId = dto.accountId;
        } else if (dto.createAccount === true) {
          // Same trx: if anything below fails the new account rolls back too.
          // Account type is the generic current asset ("Other Current Asset").
          const account = await this.createAccountService.createAccount(
            { name: label, accountType: CRYPTO_ACCOUNT_TYPE },
            trx,
          );
          accountId = account.id;
        }

        const connection = await this.connections.insert(
          {
            exchange,
            label,
            apiKeyEncrypted: apiKey.value,
            apiSecretEncrypted: apiSecret.value,
            passphraseEncrypted: passphrase?.value ?? null,
            keyVersion: apiKey.keyVersion,
            keyHint,
            status: 'active',
            accountId,
          },
          trx,
        );

        await this.auditLog.record({
          trx,
          action: 'created',
          subject: AbilitySubject.CryptoExchange,
          subjectId: connection.id,
          metadata: {
            exchange,
            label,
            keyHint,
            accountId,
            createdAccount: dto.createAccount === true,
          },
        });
        await emitConnectionEvent(
          this.eventEmitter,
          this.cls,
          cryptoEvents.connection.created,
          connection.id,
          trx,
        );
        return toConnectionView(connection);
      })
      .catch((error) => this.validators.rethrowIfDuplicateAccount(error));
  }
}
