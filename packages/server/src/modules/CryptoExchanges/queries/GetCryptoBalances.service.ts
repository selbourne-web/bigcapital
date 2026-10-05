import { Inject, Injectable } from '@nestjs/common';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { CryptoConnection } from '../models/CryptoConnection';
import { CryptoBalanceSnapshot } from '../models/CryptoBalanceSnapshot';

export interface CryptoBalanceView {
  asset: string;
  /** Decimal string, never a float. */
  free: string;
  locked: string;
}

export interface CryptoConnectionBalancesView {
  connectionId: number;
  /** Mapped asset account, `null` while the connection is unmapped. */
  accountId: number | null;
  balances: CryptoBalanceView[];
  /** When the newest snapshot of the connection was captured; `null` before the first sync. */
  capturedAt: Date | null;
}

export interface CryptoBalancesView {
  connections: CryptoConnectionBalancesView[];
}

type SnapshotRow = Pick<
  CryptoBalanceSnapshot,
  'id' | 'connectionId' | 'asset' | 'free' | 'locked' | 'capturedAt'
>;

/** `0`, `0.0000`, `-0`, `''`: a balance row that says the asset is gone. */
const isZeroAmount = (value: unknown): boolean =>
  /^[-+]?0*\.?0*$/.test(String(value ?? '').trim());

const time = (value: Date | string | null | undefined): number =>
  value ? new Date(value).getTime() : 0;

/**
 * Pure: keeps the newest row per (connection, asset), drops assets whose newest
 * row is all zero (the exchange no longer reports them), and shapes the view.
 * The database already narrows the rows to the newest ids; picking again here
 * keeps the result right even if a caller hands over older rows too.
 */
export const buildBalancesView = (
  connections: Array<Pick<CryptoConnection, 'id' | 'accountId'>>,
  snapshots: SnapshotRow[],
): CryptoBalancesView => {
  const newest = new Map<string, SnapshotRow>();
  for (const row of snapshots) {
    const key = `${row.connectionId}\u0000${row.asset}`;
    const current = newest.get(key);
    const newer =
      !current ||
      time(row.capturedAt) > time(current.capturedAt) ||
      (time(row.capturedAt) === time(current.capturedAt) &&
        row.id > current.id);
    if (newer) newest.set(key, row);
  }

  return {
    connections: connections.map((connection) => {
      const rows = [...newest.values()].filter(
        (row) => row.connectionId === connection.id,
      );
      const capturedAt = rows.reduce<Date | null>(
        (latest, row) =>
          !latest || time(row.capturedAt) > time(latest)
            ? row.capturedAt
            : latest,
        null,
      );
      return {
        connectionId: connection.id,
        accountId: connection.accountId ?? null,
        balances: rows
          .filter(
            (row) => !(isZeroAmount(row.free) && isZeroAmount(row.locked)),
          )
          .map((row) => ({
            asset: row.asset,
            free: String(row.free),
            locked: String(row.locked),
          }))
          .sort((a, b) => a.asset.localeCompare(b.asset)),
        capturedAt,
      };
    }),
  };
};

@Injectable()
export class GetCryptoBalancesService {
  constructor(
    @Inject(CryptoConnection.name)
    private readonly connectionModel: TenantModelProxy<typeof CryptoConnection>,
    @Inject(CryptoBalanceSnapshot.name)
    private readonly snapshotModel: TenantModelProxy<
      typeof CryptoBalanceSnapshot
    >,
  ) {}

  /**
   * Current holdings per non-archived connection, from the LATEST snapshot of
   * each (connection, asset). Snapshots are append-only, so the newest row of a
   * pair is its highest id; only those rows are read.
   */
  async execute(): Promise<CryptoBalancesView> {
    const connections = await this.connectionModel()
      .query()
      .whereNull('deletedAt')
      .orderBy('id');
    if (!connections.length) {
      return { connections: [] };
    }

    const latest = await this.snapshotModel()
      .query()
      .max('id as id')
      .whereIn(
        'connectionId',
        connections.map((c) => c.id),
      )
      .groupBy('connectionId', 'asset');
    const ids = latest.map((row) => row.id);
    const snapshots = ids.length
      ? await this.snapshotModel().query().whereIn('id', ids)
      : [];

    return buildBalancesView(connections, snapshots);
  }
}
