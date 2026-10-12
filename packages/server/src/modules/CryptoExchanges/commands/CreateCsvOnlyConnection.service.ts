import { Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { ServiceError } from '@/modules/Items/ServiceError';
import { UnitOfWork } from '@/modules/Tenancy/TenancyDB/UnitOfWork.service';
import { CreateAccountService } from '@/modules/Accounts/CreateAccount.service';
import { AuditLogService } from '@/modules/EE/AuditLogs/AuditLog.service';
import { AbilitySubject } from '@/modules/Roles/Roles.types';
import { CreateCsvOnlyConnectionDto } from '../dtos/CreateCsvOnlyConnection.dto';
import {
  CRYPTO_CONNECTION_ERRORS as ERRORS,
  CSV_ONLY_EXCHANGES,
  CsvOnlyExchangeId,
} from '../CryptoExchanges.constants';
import { CryptoConnectionRepository } from './CryptoConnection.repository';
import { CryptoConnectionValidators } from './CryptoConnectionValidators.service';
import { CryptoConnectionView, toConnectionView } from './CryptoConnectionView';
import {
  assertSingleAccountChoice,
  resolveConnectionAccount,
} from './CreateCryptoConnection.service';

/**
 * Creates a connection fed only by CSV imports (`mode = 'csv_only'`, e.g.
 * Nexo). There is no API key: no adapter probe, no vault, no
 * `crypto.connection.created` event and therefore no sync queue job or
 * schedule (the event is what drives them). The credential columns are NOT
 * NULL and hold '' (the convention `archive()` already uses); nothing ever
 * decrypts them because every API-only action is refused (`assertApiMode`).
 */
@Injectable()
export class CreateCsvOnlyConnectionService {
  constructor(
    private readonly connections: CryptoConnectionRepository,
    private readonly validators: CryptoConnectionValidators,
    private readonly uow: UnitOfWork,
    private readonly createAccountService: CreateAccountService,
    private readonly auditLog: AuditLogService,
  ) {}

  async execute(
    dto: CreateCsvOnlyConnectionDto,
  ): Promise<CryptoConnectionView> {
    const label = dto.label?.trim();
    if (!label) {
      throw new ServiceError(
        ERRORS.CREDENTIALS_REQUIRED,
        'A label is required.',
      );
    }
    if (!CSV_ONLY_EXCHANGES.includes(dto.exchange as CsvOnlyExchangeId)) {
      throw new ServiceError(
        ERRORS.EXCHANGE_NOT_SUPPORTED,
        'This exchange cannot be added as a CSV-only connection.',
      );
    }
    const exchange: CsvOnlyExchangeId = dto.exchange;
    assertSingleAccountChoice(dto);

    return this.uow
      .withTransaction(async (trx: Knex.Transaction) => {
        const accountId = await resolveConnectionAccount(
          this.validators,
          this.createAccountService,
          dto,
          label,
          trx,
        );
        const connection = await this.connections.insert(
          {
            exchange,
            label,
            mode: 'csv_only',
            apiKeyEncrypted: '',
            apiSecretEncrypted: '',
            passphraseEncrypted: null,
            keyHint: null,
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
            mode: 'csv_only',
            accountId,
            createdAccount: dto.createAccount === true,
          },
        });
        return toConnectionView(connection);
      })
      .catch((error) => this.validators.rethrowIfDuplicateAccount(error));
  }
}
