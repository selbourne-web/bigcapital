import knex, { Knex } from 'knex';
import { knexSnakeCaseMappers } from 'objection';
import { CryptoConnection } from '../models/CryptoConnection';
import { CryptoBalanceSnapshot } from '../models/CryptoBalanceSnapshot';
import { CryptoSyncRun } from '../models/CryptoSyncRun';
import { GetCryptoBalancesService } from './GetCryptoBalances.service';
import { GetCryptoSyncRunsService } from './GetCryptoSyncRuns.service';

/**
 * Integration spec for the SQL behind the balances and sync-runs queries, run
 * through the real Objection models against a throwaway MariaDB database.
 * Skipped unless TEST_TENANT_DB is set; refuses any name that does not start
 * with "scratch_". The database needs an `accounts` table (the crypto migration
 * references it). Connection settings come from DB_HOST / DB_USER /
 * DB_PASSWORD / DB_PORT.
 */
const dbName = process.env.TEST_TENANT_DB;
const suite = dbName ? describe : describe.skip;

const migrations = () => [
  require('../../../database/tenant/migrations/20261004000000_create_crypto_exchange_tables'),
  require('../../../database/tenant/migrations/20261004000100_add_sync_state_to_crypto_connections'),
  require('../../../database/tenant/migrations/20261004000200_add_deleted_at_to_crypto_connections'),
  require('../../../database/tenant/migrations/20261006000000_add_snapshot_latest_index_to_crypto_balance_snapshots'),
];

suite('Crypto balances and sync-runs queries (integration, scratch DB)', () => {
  jest.setTimeout(60_000);
  let db: Knex;
  let modelDb: Knex;
  let balances: GetCryptoBalancesService;
  let runs: GetCryptoSyncRunsService;
  let live1: number;
  let live2: number;
  let gone: number;

  const connection = (label: string, extra: Record<string, unknown> = {}) =>
    db('crypto_connections')
      .insert({
        exchange: 'kraken',
        label,
        api_key_encrypted: 'x',
        api_secret_encrypted: 'x',
        key_version: 1,
        status: 'active',
        ...extra,
      })
      .then(([id]) => id as number);

  const snap = (
    connectionId: number,
    asset: string,
    free: string,
    locked: string,
    at: string,
  ) =>
    db('crypto_balance_snapshots').insert({
      connection_id: connectionId,
      asset,
      free,
      locked,
      captured_at: new Date(at),
    });

  const run = (connectionId: number, n: number) =>
    db('crypto_sync_runs').insert({
      connection_id: connectionId,
      kind: 'incremental',
      status: 'succeeded',
      fetched_count: n,
      inserted_count: n,
      started_at: new Date(Date.UTC(2026, 0, 1, 0, n)),
    });

  beforeAll(async () => {
    if (!dbName.startsWith('scratch_')) {
      throw new Error(`Refusing to run against database "${dbName}".`);
    }
    const conn = {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: dbName,
    };
    db = knex({ client: 'mysql2', connection: conn });
    // Lower-case snake mapper: the scratch server is case-sensitive.
    modelDb = knex({
      client: 'mysql2',
      connection: conn,
      ...knexSnakeCaseMappers(),
    });
    for (const t of [
      'crypto_sync_runs',
      'crypto_balance_snapshots',
      'crypto_raw_records',
      'crypto_connections',
    ]) {
      await db.schema.dropTableIfExists(t);
    }
    for (const m of migrations()) await m.up(db);
    for (const model of [
      CryptoConnection,
      CryptoBalanceSnapshot,
      CryptoSyncRun,
    ]) {
      model.knex(modelDb);
    }
    balances = new GetCryptoBalancesService(
      (() => CryptoConnection) as any,
      (() => CryptoBalanceSnapshot) as any,
    );
    runs = new GetCryptoSyncRunsService(
      (() => CryptoSyncRun) as any,
      (() => CryptoConnection) as any,
    );
  });

  afterAll(async () => {
    if (db) {
      const m = migrations();
      await m[3].down(db);
      await m[2].down(db);
      await m[1].down(db);
      await m[0].down(db);
      await db.destroy();
      await modelDb.destroy();
    }
  });

  beforeEach(async () => {
    for (const t of [
      'crypto_sync_runs',
      'crypto_balance_snapshots',
      'crypto_raw_records',
      'crypto_connections',
    ]) {
      await db(t).delete();
    }
    live1 = await connection('one');
    live2 = await connection('two');
    gone = await connection('archived', { deleted_at: new Date() });
  });

  describe('GetCryptoBalances', () => {
    it('returns the latest snapshot per (connection, asset), drops assets that later went to zero, sorts by asset', async () => {
      await snap(live1, 'BTC', '1', '0', '2026-01-01T00:00:00Z');
      await snap(live1, 'ETH', '5', '0', '2026-01-01T00:00:00Z');
      await snap(live1, 'SOL', '2', '1', '2026-01-01T00:00:00Z');
      await snap(live1, 'BTC', '1.5', '0.25', '2026-01-02T00:00:00Z');
      await snap(live1, 'ETH', '0', '0', '2026-01-02T00:00:00Z'); // sold out
      await snap(live2, 'BTC', '9', '0', '2026-01-01T12:00:00Z');

      const view = await balances.execute();

      expect(view.connections.map((c) => c.connectionId)).toEqual([
        live1,
        live2,
      ]);
      const [one, two] = view.connections;
      expect(one.balances.map((b) => b.asset)).toEqual(['BTC', 'SOL']);
      expect(one.balances[0]).toEqual({
        asset: 'BTC',
        free: expect.stringMatching(/^1\.5/),
        locked: expect.stringMatching(/^0\.25/),
      });
      expect(new Date(one.capturedAt as Date).toISOString()).toBe(
        '2026-01-02T00:00:00.000Z',
      );
      expect(two.balances).toHaveLength(1);
      expect(two.balances[0]).toMatchObject({ asset: 'BTC' });
      expect(Number(two.balances[0].free)).toBe(9);
    });

    it('is tenant-safe: a soft-deleted connection and its snapshots never appear', async () => {
      await snap(live1, 'BTC', '1', '0', '2026-01-01T00:00:00Z');
      await snap(gone, 'BTC', '100', '0', '2026-01-03T00:00:00Z');

      const view = await balances.execute();

      expect(view.connections.map((c) => c.connectionId)).toEqual([
        live1,
        live2,
      ]);
      expect(JSON.stringify(view)).not.toContain('100');
    });

    it('a connection with no snapshots is listed with empty balances and null capturedAt', async () => {
      const view = await balances.execute();
      expect(view.connections).toHaveLength(2);
      for (const c of view.connections) {
        expect(c.balances).toEqual([]);
        expect(c.capturedAt).toBeNull();
      }
    });

    it('returns no connections when every connection is archived', async () => {
      await db('crypto_connections')
        .whereIn('id', [live1, live2])
        .update({ deleted_at: new Date() });
      expect(await balances.execute()).toEqual({ connections: [] });
    });
  });

  describe('GetCryptoSyncRuns', () => {
    it('lists newest first (id desc) and hides runs of archived connections', async () => {
      await run(live1, 1);
      await run(gone, 2);
      await run(live2, 3);
      await run(live1, 4);

      const list = await runs.execute({});

      expect(list.map((r) => r.fetchedCount)).toEqual([4, 3, 1]);
      expect(list.every((r) => r.connectionId !== gone)).toBe(true);
    });

    it('filters by connectionId, and an archived connectionId yields nothing', async () => {
      await run(live1, 1);
      await run(live2, 2);
      await run(gone, 3);

      const only = await runs.execute({ connectionId: live2 });
      expect(only.map((r) => r.fetchedCount)).toEqual([2]);
      expect(await runs.execute({ connectionId: gone })).toEqual([]);
    });

    it('applies the default limit 20, honours an explicit limit and caps at 100', async () => {
      for (let n = 1; n <= 105; n++) await run(live1, n);

      expect(await runs.execute({})).toHaveLength(20);
      const five = await runs.execute({ limit: 5 });
      expect(five.map((r) => r.fetchedCount)).toEqual([
        105, 104, 103, 102, 101,
      ]);
      expect(await runs.execute({ limit: 1000 })).toHaveLength(100);
      expect(await runs.execute({ limit: 0 })).toHaveLength(1);
    });

    it('returns allow-listed error entries parsed from the stored JSON', async () => {
      await db('crypto_sync_runs').insert({
        connection_id: live1,
        kind: 'initial',
        status: 'failed',
        started_at: new Date(),
        errors: JSON.stringify([
          {
            code: 'AUTH',
            message: 'Key rejected',
            retryable: false,
            at: 'now',
            cursor: 'internal',
            name: 'ExchangeAuthError',
          },
        ]),
      });
      const [first] = await runs.execute({});
      expect(first.errors).toEqual([
        { code: 'AUTH', message: 'Key rejected', retryable: false, at: 'now' },
      ]);
    });
  });
});
