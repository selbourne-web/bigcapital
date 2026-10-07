import {
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Knex } from 'knex';
import { ServiceError } from '@/modules/Items/ServiceError';
import { Account } from '@/modules/Accounts/models/Account.model';
import { ACCOUNT_ROOT_TYPE } from '@/modules/Accounts/Accounts.constants';
import { TenancyContext } from '@/modules/Tenancy/TenancyContext.service';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { AdapterRegistry } from '../adapters/AdapterRegistry';
import { Credentials, KeyInspection } from '../adapters/ExchangeAdapter';
import { KeyHasExtraPermissionsError } from '../adapters/errors';
import { RateLimiter } from '../sync/RateLimiter.service';
import {
  CRYPTO_CONNECTION_ERRORS as ERRORS,
  CryptoExchangeId,
  SUPPORTED_CRYPTO_EXCHANGES,
} from '../CryptoExchanges.constants';
import { CryptoConnectionRepository } from './CryptoConnection.repository';

export type CredentialsInput = {
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
};

@Injectable()
export class CryptoConnectionValidators {
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly rateLimiter: RateLimiter,
    @Inject(Account.name)
    private readonly accountModel: TenantModelProxy<typeof Account>,
    private readonly connections: CryptoConnectionRepository,
    private readonly tenancyContext: TenancyContext,
  ) {}

  assertSupportedExchange(
    exchange: string,
  ): asserts exchange is CryptoExchangeId {
    if (!SUPPORTED_CRYPTO_EXCHANGES.includes(exchange as CryptoExchangeId)) {
      throw new ServiceError(
        ERRORS.EXCHANGE_NOT_SUPPORTED,
        'This exchange is not supported.',
      );
    }
  }

  /** Trims, then inspects the key's permissions through the shared rate limiter. */
  async verifyCredentials(
    exchange: CryptoExchangeId,
    input: CredentialsInput,
    attestReadOnly?: boolean,
  ): Promise<Credentials> {
    const { credentials } = await this.verifyCredentialsDetailed(
      exchange,
      input,
      attestReadOnly,
    );
    return credentials;
  }

  /** Same checks as `verifyCredentials`, also returning the inspection (expiry, warnings). */
  async verifyCredentialsDetailed(
    exchange: CryptoExchangeId,
    input: CredentialsInput,
    attestReadOnly?: boolean,
  ): Promise<{ credentials: Credentials; inspection: KeyInspection }> {
    const apiKey = input.apiKey?.trim();
    const apiSecret = input.apiSecret?.trim();
    const passphrase = input.passphrase?.trim() || undefined;
    if (!apiKey || !apiSecret) {
      throw new ServiceError(
        ERRORS.CREDENTIALS_REQUIRED,
        'API key and secret are required.',
      );
    }
    const credentials: Credentials = { apiKey, apiSecret, passphrase };

    const adapter = this.registry.get(exchange);
    await this.rateLimiter.acquire(adapter.id, 1);
    const inspection = await adapter.inspectKey(credentials);

    if (inspection.readOnly === false) {
      throw new KeyHasExtraPermissionsError(inspection.permissions);
    }
    if (inspection.readOnly === 'unverifiable' && attestReadOnly !== true) {
      // The UI shows the "this key is read-only" checkbox on this code, with the
      // scopes and warnings (no secrets) the adapter reported.
      throw new UnprocessableEntityException({
        code: 'ATTESTATION_REQUIRED',
        permissions: inspection.permissions ?? [],
        warnings: inspection.warnings ?? [],
      });
    }
    return { credentials, inspection };
  }

  /**
   * An account may be mapped only when it exists, is an asset account (not
   * enforced by the database), is active, is in the tenant base currency and
   * is not mapped to another connection.
   * @param exceptConnectionId the connection being edited (re-saving its own mapping is fine)
   */
  async validateAccountMapping(
    accountId: number,
    trx?: Knex.Transaction,
    exceptConnectionId?: number,
  ): Promise<Account> {
    const account = await this.accountModel().query(trx).findById(accountId);
    if (!account) {
      throw new ServiceError(
        ERRORS.ACCOUNT_NOT_FOUND,
        'The selected account was not found.',
      );
    }
    if (account.accountRootType !== ACCOUNT_ROOT_TYPE.ASSET) {
      throw new ServiceError(
        ERRORS.ACCOUNT_NOT_ASSET,
        'Only an asset account can hold a crypto connection.',
      );
    }
    if (!account.active) {
      throw new ServiceError(
        ERRORS.ACCOUNT_INACTIVE,
        'The selected account is inactive.',
      );
    }
    const tenant = await this.tenancyContext.getTenant(true);
    const baseCurrency = tenant.metadata.baseCurrency;
    if (account.currencyCode !== baseCurrency) {
      throw new ServiceError(
        ERRORS.ACCOUNT_CURRENCY_MISMATCH,
        `The account must be in the base currency (${baseCurrency}).`,
      );
    }
    const mapped = await this.connections.findByAccountId(accountId, trx);
    if (mapped && mapped.id !== exceptConnectionId) {
      throw this.alreadyMapped(mapped.label);
    }
    return account;
  }

  /** The unique index on account_id is the backstop for a concurrent mapping. */
  rethrowIfDuplicateAccount(error: unknown): never {
    if ((error as { code?: string })?.code === 'ER_DUP_ENTRY') {
      throw this.alreadyMapped();
    }
    throw error;
  }

  private alreadyMapped(label?: string) {
    return new ServiceError(
      ERRORS.ACCOUNT_ALREADY_MAPPED,
      label
        ? `This account is already mapped to crypto connection ${label}.`
        : 'This account is already mapped to another crypto connection.',
    );
  }
}
