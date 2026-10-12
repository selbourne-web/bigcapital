import { Inject, Injectable } from '@nestjs/common';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { AdapterRegistry } from '../adapters/AdapterRegistry';
import { CryptoConnection } from '../models/CryptoConnection';
import {
  CryptoConnectionView,
  toConnectionView,
} from '../commands/CryptoConnectionView';
import { isCsvOnly } from '../commands/assertApiMode';

@Injectable()
export class GetCryptoConnectionsService {
  constructor(
    @Inject(CryptoConnection.name)
    private readonly connectionModel: TenantModelProxy<typeof CryptoConnection>,
    private readonly registry: AdapterRegistry,
  ) {}

  /**
   * Every non-archived connection (archived rows are invisible), mapped through
   * the allow-list view so credentials and ciphertext can never be returned.
   */
  async execute(): Promise<CryptoConnectionView[]> {
    const rows = await this.connectionModel()
      .query()
      .whereNull('deletedAt')
      .orderBy('id');
    // CSV-only exchanges have no adapter (the registry would throw).
    return rows.map((row) => ({
      ...toConnectionView(row),
      historyCoverage: isCsvOnly(row)
        ? null
        : this.registry.get(row.exchange).historyCoverage,
    }));
  }
}
