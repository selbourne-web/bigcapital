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

type AccountChoice = { accountId?: number | null; createAccount?: boolean };

/** Refuses a body that both maps an existing account and asks for a new one. */
export const assertSingleAccountChoice = (choice: AccountChoice): void => {
  if (choice.accountId != null && choice.createAccount === true) {
    throw new ServiceError(
      ERRORS.ACCOUNT_MAPPING_CONFLICT,
      'Choose either an existing account or create a new one, not both.',
    );
  }
};

/**
 * Account of a new connection, shared by the key-based and the CSV-only
 * create: validates an existing account, or creates one named after the label
 * in the caller's transaction (so a later failure rolls it back), or none.
 */
export const resolveConnectionAccount = async (
  validators: CryptoConnectionValidators,
  createAccountService: CreateAccountService,
  choice: AccountChoice,
  label: string,
  trx: Knex.Transaction,
): Promise<number | null> => {
  if (choice.accountId != null) {
    await validators.validateAccountMapping(choice.accountId, trx);
    return choice.accountId;
  }
  if (choice.createAccount === true) {
    // Account type is the generic current asset ("Other Current Asset").
    const account = await createAccountService.createAccount(
      { name: label, accountType: CRYPTO_ACCOUNT_TYPE },
      trx,
    );
    return account.id;
  }
  return null;
};

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

    assertSingleAccountChoice(dto);

    // Network call to the exchange happens before any transaction is opened.
    const { credentials, inspection } =
      await this.validators.verifyCredentialsDetailed(
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
        // Same trx: if anything below fails a new account rolls back too.
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
            apiKeyEncrypted: apiKey.value,
            apiSecretEncrypted: apiSecret.value,
            passphraseEncrypted: passphrase?.value ?? null,
            keyVersion: apiKey.keyVersion,
            keyHint,
            status: 'active',
            accountId,
            keyExpiresAt: inspection.expiresAt ?? null,
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
