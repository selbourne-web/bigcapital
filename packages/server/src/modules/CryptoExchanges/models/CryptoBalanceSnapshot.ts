import { TenantBaseModel } from '@/modules/System/models/TenantBaseModel';

export class CryptoBalanceSnapshot extends TenantBaseModel {
  id: number;
  connectionId: number;
  asset: string;
  free: string;
  locked: string;
  capturedAt: Date;

  static get tableName() {
    return 'crypto_balance_snapshots';
  }

  get timestamps() {
    return [];
  }
}
