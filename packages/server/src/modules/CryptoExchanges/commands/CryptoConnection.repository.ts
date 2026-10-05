import { Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { CryptoConnection } from '../models/CryptoConnection';

/**
 * Persistence for crypto connections. Archived (soft-deleted) rows are
 * invisible here; see `archive`.
 */
@Injectable()
export class CryptoConnectionRepository {
  constructor(
    @Inject(CryptoConnection.name)
    private readonly connectionModel: TenantModelProxy<typeof CryptoConnection>,
  ) {}

  findById(
    id: number,
    trx?: Knex.Transaction,
  ): Promise<CryptoConnection | undefined> {
    return this.connectionModel()
      .query(trx)
      .findById(id)
      .whereNull('deletedAt') as unknown as Promise<
      CryptoConnection | undefined
    >;
  }

  findByAccountId(
    accountId: number,
    trx?: Knex.Transaction,
  ): Promise<CryptoConnection | undefined> {
    return this.connectionModel()
      .query(trx)
      .where('accountId', accountId)
      .whereNull('deletedAt')
      .first() as unknown as Promise<CryptoConnection | undefined>;
  }

  /** Inserts and returns the stored row (including generated timestamps). */
  async insert(
    values: Partial<CryptoConnection>,
    trx: Knex.Transaction,
  ): Promise<CryptoConnection> {
    const inserted = await this.connectionModel().query(trx).insert(values);
    return this.connectionModel().query(trx).findById(inserted.id);
  }

  async patch(
    id: number,
    values: Partial<CryptoConnection>,
    trx: Knex.Transaction,
  ): Promise<CryptoConnection> {
    await this.connectionModel().query(trx).findById(id).patch(values);
    return this.connectionModel().query(trx).findById(id);
  }

  /**
   * Back to `active` with the error cleared (successful manual re-sync of an
   * `error` connection). Atomic: only an `error` row is flipped, so it never overrides a concurrent pause or
   * drift flip, and never revives an archived row.
   */
  async markActive(id: number, trx?: Knex.Transaction): Promise<void> {
    await this.connectionModel()
      .query(trx)
      .findById(id)
      .whereNull('deletedAt')
      .where('status', 'error')
      .patch({ status: 'active', lastError: null });
  }

  /**
   * Soft delete: wipes the encrypted credentials and the account mapping and
   * marks the row deleted, but keeps the row so the raw records, balance
   * snapshots and sync runs (which cascade from it) survive. Needed because
   * the child tables are ON DELETE CASCADE.
   */
  async archive(id: number, trx: Knex.Transaction): Promise<void> {
    await this.connectionModel().query(trx).findById(id).patch({
      apiKeyEncrypted: '',
      apiSecretEncrypted: '',
      passphraseEncrypted: null,
      keyHint: null,
      accountId: null,
      status: 'paused',
      syncCursor: null,
      deletedAt: new Date(),
    });
  }

  /** Hard delete; the child tables cascade, so raw data goes too. */
  async hardDelete(id: number, trx: Knex.Transaction): Promise<void> {
    await this.connectionModel().query(trx).deleteById(id);
  }
}
