import { TenantBaseModel } from '@/modules/System/models/TenantBaseModel';
import { CryptoSyncKind } from '../CryptoExchanges.constants';

export class CryptoSyncRun extends TenantBaseModel {
  id: number;
  connectionId: number;
  kind: CryptoSyncKind;
  status: string;
  rangeFrom?: Date | null;
  rangeTo?: Date | null;
  fetchedCount: number;
  insertedCount: number;
  errors?: string | null;
  startedAt: Date;
  finishedAt?: Date | null;

  static get tableName() {
    return 'crypto_sync_runs';
  }

  get timestamps() {
    return [];
  }
}
