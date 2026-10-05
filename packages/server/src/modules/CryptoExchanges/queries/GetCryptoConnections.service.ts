import { Inject, Injectable } from '@nestjs/common';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { CryptoConnection } from '../models/CryptoConnection';
import {
  CryptoConnectionView,
  toConnectionView,
} from '../commands/CryptoConnectionView';

@Injectable()
export class GetCryptoConnectionsService {
  constructor(
    @Inject(CryptoConnection.name)
    private readonly connectionModel: TenantModelProxy<typeof CryptoConnection>,
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
    return rows.map(toConnectionView);
  }
}
