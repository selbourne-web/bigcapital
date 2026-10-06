import knex, { Knex } from 'knex';
import { knexSnakeCaseMappers } from 'objection';
import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';
import { CryptoSyncOptions, CryptoSyncService } from './CryptoSync.service';
import { CryptoVault } from '../vault/CryptoVault.service';
import { CryptoConnection } from '../models/CryptoConnection';
import { CryptoRawRecord } from '../models/CryptoRawRecord';
import { CryptoBalanceSnapshot } from '../models/CryptoBalanceSnapshot';
import { CryptoSyncRun } from '../models/CryptoSyncRun';
import { cryptoSyncLockKey } from '../CryptoExchanges.constants';
import {
  Credentials,
  ExchangeAdapter,
  RawBalance,
  RawRecordInput,
} from '../adapters/ExchangeAdapter';
import {
  ExchangeAuthError,
  ExchangeError,
  ExchangeNetworkError,
  ExchangeRateLimitError,
  ExchangeSchemaError,
  KeyHasExtraPermissionsError,
} from '../adapters/errors';

/**
 * Integration spec for the sync service. Runs the real Objection models against a
 * throwaway MariaDB schema and fakes only the exchange adapter, the rate limiter and
 * Redis. Skipped unless TEST_TENANT_DB is set; refuses any name that does not start
 * with "scratch_" so it can never touch a real tenant database. The database needs an
 * `accounts` table (the crypto migration references it).
 * Connection settings come from DB_HOST / DB_USER / DB_PASSWORD / DB_PORT.
 */
const dbName = process.env.TEST_TENANT_DB;
const suite = dbName ? describe : describe.skip;

const migrations = () => [
  require('../../../database/tenant/migrations/20261004000000_create_crypto_exchange_tables'),
  require('../../../database/tenant/migrations/20261004000100_add_sync_state_to_crypto_connections'),
];

const API_KEY = 'AKIA-DISTINCTIVE-KEY-7731';
const API_SECRET = 'SECRET-DISTINCTIVE-9482-zq';
const PASSPHRASE = 'PASS-DISTINCTIVE-5520';

type Page = { records: RawRecordInput[]; nextCursor?: string } | Error;

class StubAdapter implements ExchangeAdapter {
  id = 'kraken' as const;
  rateLimit: ExchangeAdapter['rateLimit'] = {
    capacity: 15,
    refillPerSec: 1,
    historyPageCost: 2,
  };
  balances: RawBalance[] = [];
  balanceError?: Error;
  balanceDelayMs = 0;
  /** Runs after each successful history page (e.g. to advance a fake clock). */
  onHistory?: () => void;
  /** Keyed by the cursor the service passes ('start' when none). */
  pages: Record<string, Page> = {};
  calls: string[] = [];
  credentialsSeen: Credentials[] = [];
  queries: Array<{ since?: Date; cursor?: string; knownAssets?: string[] }> =
    [];

  async inspectKey() {
    return { readOnly: true as const, permissions: [] };
  }

  async fetchBalances(c: Credentials) {
    this.calls.push('balances');
    this.credentialsSeen.push(c);
    if (this.balanceDelayMs) {
      await new Promise((r) => setTimeout(r, this.balanceDelayMs));
    }
    if (this.balanceError) throw this.balanceError;
    return this.balances;
  }

  async fetchHistory(
    c: Credentials,
    q: { since?: Date; cursor?: string; knownAssets?: string[] },
  ) {
    this.calls.push('history');
    this.credentialsSeen.push(c);
    this.queries.push({ ...q });
    const page = this.pages[q.cursor ?? 'start'];
    if (!page) throw new Error(`no stub page for cursor ${q.cursor}`);
    if (page instanceof Error) throw page;
    this.onHistory?.();
    return page;
  }
}

const rec = (
  n: number,
  extra: Record<string, unknown> = {},
): RawRecordInput => ({
  type: 'trade',
  exchangeRecordId: `T${n}`,
  occurredAt: new Date(Date.UTC(2026, 0, 1, 0, n)),
  payload: { id: n, ...extra },
});

const ORG = 'org-1';

suite('CryptoSyncService (integration, scratch DB)', () => {
  let db: Knex;
  let modelDb: Knex;
  let vault: CryptoVault;
  let adapter: StubAdapter;
  let limiter: { acquire: jest.Mock };
  let redisStore: Map<string, string>;
  let connectionId: number;

  const fakeRedis = () => ({
    set: async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && redisStore.has(key)) return null;
      redisStore.set(key, value);
      return 'OK';
    },
    // eval(script, 1, key, token[, ttl]): compare-then-pexpire or compare-and-delete.
    eval: async (script: string, _n: number, key: string, token: string) => {
      if (redisStore.get(key) !== token) return 0;
      if (script.includes('pexpire')) return 1; // lock extension
      redisStore.delete(key); // release
      return 1;
    },
  });

  const make = (options: CryptoSyncOptions = {}) =>
    new CryptoSyncService(
      (() => CryptoConnection) as any,
      (() => CryptoRawRecord) as any,
      (() => CryptoBalanceSnapshot) as any,
      (() => CryptoSyncRun) as any,
      vault,
      { get: () => adapter } as any,
      limiter as any,
      { getOrThrow: () => fakeRedis() } as any,
      options,
    );

  const connection = () => CryptoConnection.query().findById(connectionId);
  const rawRecords = () =>
    db('crypto_raw_records')
      .where({ connection_id: connectionId })
      .orderBy('id');
  const snapshots = (asset?: string) =>
    db('crypto_balance_snapshots')
      .where({ connection_id: connectionId })
      .modify((q) => {
        if (asset) q.where({ asset });
      })
      .orderBy('id');
  const sum = (row: { free: string; locked: string }) =>
    Number(row.free) + Number(row.locked);

  beforeAll(async () => {
    Logger.overrideLogger(false); // keep expected failure warnings out of test output
    if (!dbName.startsWith('scratch_')) {
      throw new Error(`Refusing to run against database "${dbName}".`);
    }
    const connection = {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: dbName,
    };
    // Plain connection for migrations and raw assertions (snake_case columns).
    db = knex({ client: 'mysql2', connection });
    // The app maps camelCase model fields to snake_case columns; the app's mapper
    // also upper-cases identifiers, which a case-sensitive scratch server rejects,
    // so the test uses the lower-case variant.
    modelDb = knex({
      client: 'mysql2',
      connection,
      ...knexSnakeCaseMappers(),
    });
    await db.schema.dropTableIfExists('crypto_sync_runs');
    await db.schema.dropTableIfExists('crypto_balance_snapshots');
    await db.schema.dropTableIfExists('crypto_raw_records');
    await db.schema.dropTableIfExists('crypto_connections');
    await migrations()[0].up(db);
    await migrations()[1].up(db);
    for (const model of [
      CryptoConnection,
      CryptoRawRecord,
      CryptoBalanceSnapshot,
      CryptoSyncRun,
    ]) {
      model.knex(modelDb);
    }
    vault = new CryptoVault({
      get: () => ({
        encryptionKeys: { 1: Buffer.alloc(32, 7).toString('base64') },
        currentKeyVersion: 1,
      }),
    } as any);
  });

  afterAll(async () => {
    if (db) {
      await migrations()[1].down(db);
      await migrations()[0].down(db);
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
    adapter = new StubAdapter();
    limiter = { acquire: jest.fn().mockResolvedValue(undefined) };
    redisStore = new Map();
    const enc = (v: string) => vault.encrypt(v).value;
    [connectionId] = await db('crypto_connections').insert({
      exchange: 'kraken',
      label: 'Kraken - Trading',
      api_key_encrypted: enc(API_KEY),
      api_secret_encrypted: enc(API_SECRET),
      passphrase_encrypted: enc(PASSPHRASE),
      key_version: 1,
      status: 'active',
    });
  });

  it('(a) re-syncing overlapping records inserts 0 new rows and counts accurately', async () => {
    const service = make();
    adapter.pages = { start: { records: [rec(1), rec(2)] } };
    const first = await service.syncConnection(connectionId, 'initial', ORG);
    expect(first).toMatchObject({
      status: 'succeeded',
      fetchedCount: 2,
      insertedCount: 2,
    });

    adapter.pages = { start: { records: [rec(2), rec(3)] } };
    const second = await service.syncConnection(
      connectionId,
      'incremental',
      ORG,
    );
    expect(second).toMatchObject({
      status: 'succeeded',
      fetchedCount: 2,
      insertedCount: 1,
    });

    const third = await service.syncConnection(
      connectionId,
      'incremental',
      ORG,
    );
    expect(third).toMatchObject({ fetchedCount: 2, insertedCount: 0 });
    expect(await rawRecords()).toHaveLength(3);
  });

  it('incremental sync asks for last_seen_at minus the 10 minute overlap', async () => {
    const service = make();
    const seen = new Date('2026-03-01T12:00:00Z');
    await db('crypto_connections')
      .where({ id: connectionId })
      .update({ last_seen_at: seen, initial_sync_completed_at: seen });
    adapter.pages = { start: { records: [] } };
    await service.syncConnection(connectionId, 'incremental', ORG);
    expect(adapter.queries[0].since.getTime()).toBe(
      seen.getTime() - 10 * 60_000,
    );
  });

  it('(b) an interrupted initial sync resumes from the saved cursor, not page 1', async () => {
    const service = make();
    adapter.pages = {
      start: { records: [rec(1)], nextCursor: 'c2' },
      c2: { records: [rec(2)], nextCursor: 'c3' },
      c3: new ExchangeNetworkError(),
    };
    await expect(
      service.syncConnection(connectionId, 'initial', ORG),
    ).rejects.toBeInstanceOf(ExchangeNetworkError);
    const interrupted = await connection();
    expect(interrupted.syncCursor).toBe('c3');
    expect(interrupted.initialSyncCompletedAt).toBeNull();
    expect(interrupted.status).toBe('active');

    adapter.queries = [];
    adapter.pages.c3 = { records: [rec(3)] };
    const run = await service.syncConnection(connectionId, 'initial', ORG);
    expect(adapter.queries.map((q) => q.cursor)).toEqual(['c3']);
    expect(run.status).toBe('succeeded');
    const done = await connection();
    expect(done.syncCursor).toBeNull();
    expect(done.initialSyncCompletedAt).not.toBeNull();
    expect(done.lastSeenAt).not.toBeNull();
    expect(await rawRecords()).toHaveLength(3);
  });

  it('bounded slices: stops at maxPagesPerRun with a partial run and the cursor saved', async () => {
    const service = make({ maxPagesPerRun: 2 });
    adapter.pages = {
      start: { records: [rec(1)], nextCursor: 'c2' },
      c2: { records: [rec(2)], nextCursor: 'c3' },
      c3: { records: [rec(3)], nextCursor: 'c4' },
      c4: { records: [rec(4)] },
    };
    const slice1 = await service.syncConnection(connectionId, 'initial', ORG);
    expect(slice1.status).toBe('partial');
    expect(adapter.queries).toHaveLength(2);
    const mid = await connection();
    expect(mid.syncCursor).toBe('c3');
    expect(mid.initialSyncCompletedAt).toBeNull();

    const slice2 = await service.syncConnection(connectionId, 'initial', ORG);
    expect(slice2.status).toBe('succeeded');
    expect(adapter.queries.map((q) => q.cursor)).toEqual([
      undefined,
      'c2',
      'c3',
      'c4',
    ]);
    const done = await connection();
    expect(done.syncCursor).toBeNull();
    expect(done.initialSyncCompletedAt).not.toBeNull();
  });

  it('charges the rate limiter 1 for balances and historyPageCost per history page', async () => {
    const service = make();
    adapter.pages = {
      start: { records: [rec(1)], nextCursor: 'c2' },
      c2: { records: [] },
    };
    await service.syncConnection(connectionId, 'initial', ORG);
    expect(limiter.acquire.mock.calls).toEqual([
      ['kraken', 1],
      ['kraken', 2],
      ['kraken', 2],
    ]);

    limiter.acquire.mockClear();
    adapter.rateLimit = { capacity: 15, refillPerSec: 1 };
    adapter.pages = { start: { records: [] } };
    await service.syncConnection(connectionId, 'incremental', ORG);
    expect(limiter.acquire.mock.calls).toEqual([
      ['kraken', 1],
      ['kraken', 1],
    ]);
  });

  it('decrypts credentials for the adapter only for the call', async () => {
    adapter.pages = { start: { records: [] } };
    await make().syncConnection(connectionId, 'initial', ORG);
    expect(adapter.credentialsSeen[0]).toEqual({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      passphrase: PASSPHRASE,
    });
  });

  describe('(c) error classification', () => {
    it.each([
      ['auth', () => new ExchangeAuthError()],
      ['extra permissions', () => new KeyHasExtraPermissionsError(['trade'])],
    ])(
      '%s error sets status error, fails the run and is not retried',
      async (_name, build) => {
        const err = build();
        adapter.balanceError = err;
        const run = await make().syncConnection(
          connectionId,
          'incremental',
          ORG,
        );
        expect(run.status).toBe('failed');
        expect(adapter.calls).toEqual(['balances']);
        const conn = await connection();
        expect(conn.status).toBe('error');
        expect(conn.lastError).toBe(err.userMessage);
        expect(conn.lastSyncAt).toBeNull();
        expect(JSON.parse(run.errors)[0].message).toBe(err.userMessage);
      },
    );

    it('an auth error during history also stops without a retry', async () => {
      adapter.pages = { start: new ExchangeAuthError() };
      const run = await make().syncConnection(connectionId, 'initial', ORG);
      expect(run.status).toBe('failed');
      expect(adapter.calls).toEqual(['balances', 'history']);
      expect((await connection()).status).toBe('error');
    });

    it.each([
      ['network', () => new ExchangeNetworkError()],
      ['rate limit', () => new ExchangeRateLimitError()],
      ['unknown', () => new Error('boom')],
    ])(
      '%s error leaves status unchanged, records the run and propagates',
      async (_name, build) => {
        adapter.pages = { start: build() };
        await expect(
          make().syncConnection(connectionId, 'initial', ORG),
        ).rejects.toBeDefined();
        const conn = await connection();
        expect(conn.status).toBe('active');
        expect(conn.lastSyncAt).toBeNull();
        const runs = await db('crypto_sync_runs').where({
          connection_id: connectionId,
        });
        expect(runs).toHaveLength(1);
        expect(runs[0].status).toBe('failed');
        expect(runs[0].finished_at).not.toBeNull();
        expect(JSON.parse(runs[0].errors)).toHaveLength(1);
      },
    );

    it('a retryable error after progress yields a partial run with the counts so far', async () => {
      adapter.pages = {
        start: { records: [rec(1), rec(2)], nextCursor: 'c2' },
        c2: new ExchangeRateLimitError(),
      };
      await expect(
        make().syncConnection(connectionId, 'initial', ORG),
      ).rejects.toBeInstanceOf(ExchangeRateLimitError);
      const [run] = await db('crypto_sync_runs').where({
        connection_id: connectionId,
      });
      expect(run).toMatchObject({
        status: 'partial',
        fetched_count: 2,
        inserted_count: 2,
      });
    });
  });

  it('(d) a schema error stores an unparsed raw record and marks the run partial', async () => {
    const body = { unexpected: 'shape', apiKey: 'leak-me' };
    adapter.pages = { start: new ExchangeSchemaError('bad shape', body) };
    const run = await make().syncConnection(connectionId, 'initial', ORG);
    expect(run.status).toBe('partial');

    const rows = await rawRecords();
    expect(rows).toHaveLength(1);
    const sanitized = { unexpected: 'shape', apiKey: '[REDACTED]' };
    expect(rows[0].record_type).toBe('unparsed');
    expect(rows[0].exchange_record_id).toBe(
      createHash('sha256').update(JSON.stringify(sanitized)).digest('hex'),
    );
    const payload =
      typeof rows[0].payload === 'string'
        ? JSON.parse(rows[0].payload)
        : rows[0].payload;
    expect(payload).toEqual({ parseError: true, body: sanitized });
    const conn = await connection();
    expect(conn.status).toBe('active');
    expect(conn.initialSyncCompletedAt).toBeNull();

    // Same body again: idempotent, no second row.
    await make().syncConnection(connectionId, 'initial', ORG);
    expect(await rawRecords()).toHaveLength(1);
  });

  it('(e) two simultaneous syncs share one run and one adapter call sequence', async () => {
    adapter.balanceDelayMs = 80;
    adapter.pages = { start: { records: [rec(1)] } };
    const service = make();
    const [a, b] = await Promise.all([
      service.syncConnection(connectionId, 'manual', ORG),
      service.syncConnection(connectionId, 'manual', ORG),
    ]);
    expect(a.id).toBe(b.id);
    expect(adapter.calls).toEqual(['balances', 'history']);
    expect(
      await db('crypto_sync_runs').where({ connection_id: connectionId }),
    ).toHaveLength(1);
    expect(redisStore.size).toBe(0); // lock released
  });

  it('releases the lock even when the sync throws', async () => {
    adapter.pages = { start: new ExchangeNetworkError() };
    await expect(
      make().syncConnection(connectionId, 'initial', ORG),
    ).rejects.toBeDefined();
    expect(redisStore.size).toBe(0);
  });

  it('(f) credentials never reach last_error, run errors, thrown errors, raw records or logs', async () => {
    const logged: string[] = [];
    const capture =
      () =>
      (...a: unknown[]) => {
        logged.push(JSON.stringify(a));
      };
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
      (m) => jest.spyOn(Logger.prototype, m).mockImplementation(capture()),
    );
    const consoleSpies = (
      ['log', 'warn', 'error', 'info', 'debug'] as const
    ).map((m) => jest.spyOn(console, m).mockImplementation(capture()));
    try {
      const leak = `request failed key=${API_KEY} secret=${API_SECRET} pass=${PASSPHRASE}`;
      adapter.pages = { start: new Error(leak) };
      let thrown: Error | undefined;
      await make()
        .syncConnection(connectionId, 'initial', ORG)
        .catch((e) => {
          thrown = e;
        });
      expect(thrown).toBeDefined();

      adapter.pages = {
        start: new ExchangeSchemaError('bad', {
          note: `echoed ${API_SECRET}`,
        }),
      };
      await make().syncConnection(connectionId, 'initial', ORG);

      const conn = await connection();
      const runs = await db('crypto_sync_runs');
      const records = await rawRecords();
      const everything = JSON.stringify([
        conn,
        runs,
        records,
        thrown.message,
        thrown.stack,
        logged,
      ]);
      for (const secret of [API_KEY, API_SECRET, PASSPHRASE]) {
        expect(everything).not.toContain(secret);
      }
    } finally {
      [...spies, ...consoleSpies].forEach((s) => s.mockRestore());
    }
  });

  it('(f2) a full multi-page sync plus transient failures writes no credential to logs, stdout or stderr', async () => {
    const logged: string[] = [];
    const capture =
      () =>
      (...a: unknown[]) => {
        logged.push(JSON.stringify(a));
      };
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
      (m) => jest.spyOn(Logger.prototype, m).mockImplementation(capture()),
    );
    const consoleSpies = (
      ['log', 'warn', 'error', 'info', 'debug'] as const
    ).map((m) => jest.spyOn(console, m).mockImplementation(capture()));
    const outSpies = (['stdout', 'stderr'] as const).map((s) =>
      jest.spyOn(process[s], 'write').mockImplementation(((chunk: unknown) => {
        logged.push(String(chunk));
        return true;
      }) as any),
    );
    try {
      adapter.balances = [{ asset: 'BTC', free: '1', locked: '0' }];
      adapter.pages = {
        start: { records: [rec(1), rec(2)], nextCursor: 'p2' },
        p2: { records: [rec(3)] },
      };
      const ok = await make().syncConnection(connectionId, 'initial', ORG);
      expect(ok.status).toBe('succeeded');

      for (const failure of [
        new ExchangeNetworkError(),
        new ExchangeRateLimitError(),
        new ExchangeAuthError(),
      ]) {
        adapter.pages = { start: failure };
        await make()
          .syncConnection(connectionId, 'incremental', ORG)
          .catch(() => undefined);
      }
      const everything = JSON.stringify(logged);
      for (const secret of [API_KEY, API_SECRET, PASSPHRASE]) {
        expect(everything).not.toContain(secret);
      }
      // The adapter did receive the decrypted credentials: the capture is not vacuous.
      expect(adapter.credentialsSeen[0].apiKey).toBe(API_KEY);
    } finally {
      [...spies, ...consoleSpies, ...outSpies].forEach((s) => s.mockRestore());
    }
  });

  describe('(g) balance snapshots', () => {
    it('stores and reports a dotted tokenized-stock asset (Kraken CRCLX.T) like any other', async () => {
      const service = make();
      adapter.pages = { start: { records: [] } };
      adapter.balances = [
        { asset: 'CRCLX.T', free: '1.5', locked: '0' },
        { asset: 'LDADA', free: '10', locked: '0' },
      ];
      await service.syncConnection(connectionId, 'initial', ORG);
      expect((await snapshots()).map((r) => r.asset).sort()).toEqual([
        'CRCLX.T',
        'LDADA',
      ]);
      expect(await service.heldAssets(connectionId)).toEqual([
        'CRCLX.T',
        'LDADA',
      ]);
    });

    it('skips all-zero assets, writes exactly one zero row when a held asset drops out, then nothing more', async () => {
      const service = make();
      adapter.pages = { start: { records: [] } };
      adapter.balances = [
        { asset: 'BTC', free: '1', locked: '0' },
        { asset: 'ETH', free: '0', locked: '0' },
        { asset: 'SOL', free: '0', locked: '2' },
      ];
      await service.syncConnection(connectionId, 'initial', ORG);
      expect((await snapshots()).map((r) => r.asset).sort()).toEqual([
        'BTC',
        'SOL',
      ]);
      expect(await service.heldAssets(connectionId)).toEqual(['BTC', 'SOL']);

      // SOL reported as zero, ETH still zero.
      adapter.balances = [
        { asset: 'BTC', free: '1', locked: '0' },
        { asset: 'ETH', free: '0', locked: '0' },
        { asset: 'SOL', free: '0', locked: '0' },
      ];
      await service.syncConnection(connectionId, 'incremental', ORG);
      const sol = await snapshots('SOL');
      expect(sol).toHaveLength(2);
      expect(sum(sol[1])).toBe(0);
      expect(await snapshots('ETH')).toHaveLength(0);
      expect(await service.heldAssets(connectionId)).toEqual(['BTC']);

      // Next run: SOL zero again -> no further row.
      await service.syncConnection(connectionId, 'incremental', ORG);
      expect(await snapshots('SOL')).toHaveLength(2);

      // BTC disappears from the response entirely -> one zero row.
      adapter.balances = [];
      await service.syncConnection(connectionId, 'incremental', ORG);
      const btc = await snapshots('BTC');
      expect(btc).toHaveLength(4); // 1, 1, 1, then the zero row
      expect(sum(btc[3])).toBe(0);
      await service.syncConnection(connectionId, 'incremental', ORG);
      expect(await snapshots('BTC')).toHaveLength(4);
      expect(await service.heldAssets(connectionId)).toEqual([]);
    });
  });

  it('passes knownAssets (snapshots plus stored payload assets) on incremental, not initial', async () => {
    const service = make();
    adapter.balances = [{ asset: 'ETH', free: '1', locked: '0' }];
    adapter.pages = {
      start: {
        records: [
          rec(1, { coin: 'DOGE' }),
          {
            ...rec(2),
            payload: { commissionAsset: 'bnb', fills: [{ asset: 'ada' }] },
          },
        ],
      },
    };
    await service.syncConnection(connectionId, 'initial', ORG);
    expect(adapter.queries[0].since).toBeUndefined();
    expect(adapter.queries[0].knownAssets).toBeUndefined();

    adapter.queries = [];
    await service.syncConnection(connectionId, 'incremental', ORG);
    expect([...adapter.queries[0].knownAssets].sort()).toEqual([
      'ADA',
      'BNB',
      'DOGE',
      'ETH',
    ]);
  });

  it('records the run row and updates last_sync_at / clears last_error on success', async () => {
    await db('crypto_connections')
      .where({ id: connectionId })
      .update({ last_error: 'old problem' });
    adapter.pages = { start: { records: [rec(1)] } };
    const run = await make().syncConnection(connectionId, 'initial', ORG);
    expect(run).toMatchObject({
      connectionId,
      kind: 'initial',
      status: 'succeeded',
      fetchedCount: 1,
      insertedCount: 1,
    });
    expect(run.startedAt).toBeTruthy();
    expect(run.finishedAt).toBeTruthy();
    const conn = await connection();
    expect(conn.lastSyncAt).not.toBeNull();
    expect(conn.lastError).toBeNull();
  });

  describe('review fixes', () => {
    const lockKey = () => cryptoSyncLockKey(ORG, connectionId);
    const insertRun = (extra: Record<string, unknown>) =>
      db('crypto_sync_runs').insert({
        connection_id: connectionId,
        kind: 'manual',
        status: 'succeeded',
        started_at: new Date(),
        ...extra,
      });

    it('I1: a balances schema error stores unparsed, keeps history going, and leaves the run partial and initial incomplete', async () => {
      adapter.balanceError = new ExchangeSchemaError('bad', { odd: true });
      adapter.pages = { start: { records: [rec(1)] } };
      const run = await make().syncConnection(connectionId, 'initial', ORG);
      expect(run.status).toBe('partial');
      expect(run.continuation).toBe(false);
      expect(adapter.calls).toEqual(['balances', 'history']);
      expect((await rawRecords()).map((r) => r.record_type).sort()).toEqual([
        'trade',
        'unparsed',
      ]);
      expect((await connection()).initialSyncCompletedAt).toBeNull();
    });

    it('I2: aborts retryably when the lock extension fails, failing the run without touching status', async () => {
      adapter.pages = {
        start: { records: [rec(1)], nextCursor: 'c2' },
        c2: { records: [rec(2)] },
      };
      // After page 1 another worker "owns" the lock (ours expired).
      adapter.onHistory = () => redisStore.set(lockKey(), 'someone-else');
      await expect(
        make().syncConnection(connectionId, 'initial', ORG),
      ).rejects.toBeInstanceOf(ExchangeNetworkError);
      expect(adapter.queries).toHaveLength(1);
      const [run] = await db('crypto_sync_runs').where({
        connection_id: connectionId,
      });
      expect(run.status).toBe('failed');
      const conn = await connection();
      expect(conn.status).toBe('active');
      expect(conn.lastError).toBeNull();
      expect(redisStore.get(lockKey())).toBe('someone-else'); // not released by us
    });

    it('I2: stops at the slice time budget with a partial run, cursor saved and continuation true', async () => {
      let t = Date.parse('2026-05-01T00:00:00Z');
      adapter.pages = {
        start: { records: [rec(1)], nextCursor: 'c2' },
        c2: { records: [rec(2)], nextCursor: 'c3' },
        c3: { records: [rec(3)] },
      };
      adapter.onHistory = () => {
        t += 4 * 60_000;
      };
      const run = await make({
        now: () => new Date(t),
        sliceBudgetMs: 7 * 60_000,
      }).syncConnection(connectionId, 'initial', ORG);
      // Pages at +0 and +4 min are fetched; the check at +8 min stops the slice.
      expect(adapter.queries.map((q) => q.cursor)).toEqual([undefined, 'c2']);
      expect(run.status).toBe('partial');
      expect(run.continuation).toBe(true);
      expect((await connection()).syncCursor).toBe('c3');
    });

    it('I3: continuation is true for a page-budget partial and false for a finished sync', async () => {
      adapter.pages = {
        start: { records: [rec(1)], nextCursor: 'c2' },
        c2: { records: [rec(2)] },
      };
      const slice = await make({ maxPagesPerRun: 1 }).syncConnection(
        connectionId,
        'initial',
        ORG,
      );
      expect(slice.status).toBe('partial');
      expect(slice.continuation).toBe(true);
      const done = await make().syncConnection(connectionId, 'initial', ORG);
      expect(done.status).toBe('succeeded');
      expect(done.continuation).toBe(false);
    });

    it('I3: schema-blocked runs carry SCHEMA_DRIFT, have no continuation, and three in a row at one cursor flip status to error', async () => {
      adapter.pages = { start: new ExchangeSchemaError('bad', { odd: 1 }) };
      const service = make();
      for (let i = 1; i <= 3; i++) {
        const run = await service.syncConnection(connectionId, 'initial', ORG);
        expect(run.status).toBe('partial');
        expect(run.continuation).toBe(false);
        expect(JSON.parse(run.errors)[0].code).toBe('SCHEMA_DRIFT');
        expect((await connection()).status).toBe(i < 3 ? 'active' : 'error');
      }
      expect((await connection()).lastError).toBe(
        'Exchange response format not recognised',
      );
    });

    it('I3: blocked runs at different cursors do not flip the status', async () => {
      adapter.pages = {
        start: { records: [rec(1)], nextCursor: 'c2' },
        c2: new ExchangeSchemaError('bad', { odd: 1 }),
      };
      const service = make({ maxPagesPerRun: 1 });
      await service.syncConnection(connectionId, 'initial', ORG); // advances to c2
      await service.syncConnection(connectionId, 'initial', ORG); // blocked at c2
      await service.syncConnection(connectionId, 'initial', ORG); // blocked at c2
      // Only two blocked runs share a cursor (the first run was a good slice).
      expect((await connection()).status).toBe('active');
    });

    it('I4: returns the just-finished run when the holder completes between the failed SET NX and the poll', async () => {
      redisStore.set(lockKey(), 'holder');
      const [runId] = await insertRun({
        finished_at: new Date(Date.now() + 1000),
      });
      const run = await make().syncConnection(connectionId, 'manual', ORG);
      expect(run.id).toBe(runId);
      expect(run.continuation).toBe(false);
      expect(adapter.calls).toEqual([]);
    });

    it('I4: ignores a stale running row older than the lock TTL', async () => {
      redisStore.set(lockKey(), 'holder');
      await insertRun({
        status: 'running',
        started_at: new Date(Date.now() - 20 * 60_000),
      });
      await expect(
        make({ lockPollMs: 1 }).syncConnection(connectionId, 'manual', ORG),
      ).rejects.toThrow(/already starting/);
    });

    it('refuses paused connections for every kind and error connections unless manual', async () => {
      adapter.pages = { start: { records: [] } };
      await db('crypto_connections')
        .where({ id: connectionId })
        .update({ status: 'paused' });
      for (const kind of ['initial', 'incremental', 'manual'] as const) {
        await expect(
          make().syncConnection(connectionId, kind, ORG),
        ).rejects.toMatchObject({ retryable: false });
      }
      await db('crypto_connections')
        .where({ id: connectionId })
        .update({ status: 'error' });
      await expect(
        make().syncConnection(connectionId, 'incremental', ORG),
      ).rejects.toBeInstanceOf(ExchangeError);
      expect(adapter.calls).toEqual([]);
      const run = await make().syncConnection(connectionId, 'manual', ORG);
      expect(run.status).toBe('succeeded');
    });
  });
});
