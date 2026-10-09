import { readFileSync } from 'fs';
import { join } from 'path';
import knex, { Knex } from 'knex';
import { knexSnakeCaseMappers } from 'objection';
import { CryptoConnection } from '../models/CryptoConnection';
import { CryptoRawRecord } from '../models/CryptoRawRecord';
import { CryptoCsvImport } from '../models/CryptoCsvImport';
import { CsvImportService } from '../csv/CsvImport.service';
import { CsvParserRegistry } from '../csv/CsvParserRegistry';
import { PIONEX_CSV_PARSERS } from '../csv/parsers/pionex/pionex.parsers';
import { computePayloadHash } from '../utils/payloadHash';
import { CryptoConnectionRepository } from './CryptoConnection.repository';
import { CryptoCsvImportRepository } from './CryptoCsvImport.repository';
import { PreviewCryptoCsvImportService } from './PreviewCryptoCsvImport.service';
import { CommitCryptoCsvImportService } from './CommitCryptoCsvImport.service';
import { RollbackCryptoCsvImportService } from './RollbackCryptoCsvImport.service';
import { GetCryptoCsvImportsService } from '../queries/GetCryptoCsvImports.service';
import { FakeAudit, FakeEvents, fakeCls } from './testFakes';

/**
 * Integration spec against a throwaway MariaDB database: real Objection models,
 * migrations, repository, INSERT IGNORE and transactions. Skipped unless
 * TEST_TENANT_DB is set; refuses any name that does not start with "scratch_".
 * Connection settings come from DB_HOST / DB_USER / DB_PASSWORD / DB_PORT.
 */
const dbName = process.env.TEST_TENANT_DB;
const suite = dbName ? describe : describe.skip;

const migrations = () => [
  require('../../../database/tenant/migrations/20261004000000_create_crypto_exchange_tables'),
  require('../../../database/tenant/migrations/20261004000100_add_sync_state_to_crypto_connections'),
  require('../../../database/tenant/migrations/20261004000200_add_deleted_at_to_crypto_connections'),
  require('../../../database/tenant/migrations/20261007000000_add_key_expires_at_to_crypto_connections'),
  require('../../../database/tenant/migrations/20261008000000_create_crypto_csv_imports'),
];

const fixture = (name: string) =>
  readFileSync(join(__dirname, '../csv/parsers/pionex/__fixtures__', name));

const RAW_HEADER =
  '"date(UTC+0)","executed_qty","amount","price","order_type","side","symbol","state","fee","fee_coin","market_type","tax_id"\n';
const rawTradingCsv = (good: number): Buffer => {
  const rows: string[] = [];
  for (let i = 0; i < good; i++) {
    const t = new Date(Date.UTC(2020, 0, 1) + i * 1000);
    const date = t.toISOString().slice(0, 19).replace('T', ' ');
    rows.push(
      `"${date}","1.5","10","6.5","LIMIT","BUY","TEST_USDT","FILLED","0.1","TEST","Spot","s_${i}"`,
    );
  }
  return Buffer.from(RAW_HEADER + rows.join('\n') + '\n');
};
const upload = (buffer: Buffer, originalname = 'trading.csv') => ({
  buffer,
  originalname,
});

suite('Crypto CSV import (integration, scratch DB)', () => {
  jest.setTimeout(120_000);
  let db: Knex;
  let modelDb: Knex;
  let imports: CryptoCsvImportRepository;
  let preview: PreviewCryptoCsvImportService;
  let commit: CommitCryptoCsvImportService;
  let rollback: RollbackCryptoCsvImportService;
  let list: GetCryptoCsvImportsService;
  let csv: CsvImportService;
  let events: FakeEvents;
  let audit: FakeAudit;
  let connectionId: number;

  const addConnection = async (extra: Record<string, unknown> = {}) => {
    const [id] = await db('crypto_connections').insert({
      exchange: 'pionex',
      label: 'Pionex',
      api_key_encrypted: 'k',
      api_secret_encrypted: 's',
      ...extra,
    });
    return id as number;
  };
  const rawRows = (where: Record<string, unknown> = {}) =>
    db('crypto_raw_records').where(where).orderBy('id');

  beforeAll(async () => {
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
    db = knex({ client: 'mysql2', connection });
    modelDb = knex({ client: 'mysql2', connection, ...knexSnakeCaseMappers() });
    for (const t of [
      'crypto_sync_runs',
      'crypto_balance_snapshots',
      'crypto_raw_records',
      'crypto_csv_imports',
      'crypto_connections',
    ]) {
      await db.schema.dropTableIfExists(t);
    }
    for (const m of migrations()) await m.up(db);
    CryptoConnection.knex(modelDb);
    CryptoRawRecord.knex(modelDb);
    CryptoCsvImport.knex(modelDb);

    const connections = new CryptoConnectionRepository(() => CryptoConnection);
    imports = new CryptoCsvImportRepository(
      () => CryptoCsvImport,
      () => CryptoRawRecord,
    );
    csv = new CsvImportService(new CsvParserRegistry(PIONEX_CSV_PARSERS));
    events = new FakeEvents();
    audit = new FakeAudit();
    preview = new PreviewCryptoCsvImportService(connections, imports, csv);
    commit = new CommitCryptoCsvImportService(
      connections,
      imports,
      csv,
      audit as any,
      events as any,
      fakeCls(),
    );
    rollback = new RollbackCryptoCsvImportService(
      imports,
      audit as any,
      events as any,
      fakeCls(),
    );
    list = new GetCryptoCsvImportsService(connections, imports);
  });

  afterAll(async () => {
    if (db) {
      const m = migrations();
      for (const migration of [...m].reverse()) await migration.down(db);
      await db.destroy();
      await modelDb.destroy();
    }
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    events.emitted = [];
    for (const t of [
      'crypto_raw_records',
      'crypto_csv_imports',
      'crypto_connections',
    ]) {
      await db(t).delete();
    }
    connectionId = await addConnection();
  });

  const previewAndCommit = async (buffer: Buffer, id = connectionId) => {
    const p = await preview.execute(id, upload(buffer), 1);
    return { p, view: await commit.execute(p.importId, { buffer }) };
  };

  it('previews without writing raw records and reports the date range', async () => {
    const p = await preview.execute(
      connectionId,
      upload(fixture('trading.csv'), 'a b.csv'),
      1,
    );
    expect(p).toMatchObject({
      rowCount: 2,
      importable: 2,
      alreadyImported: 0,
      byType: { trade_summary: 2 },
      dateFrom: '2020-01-02T03:04:05.000Z',
      dateTo: '2020-01-03T05:06:07.000Z',
      filename: 'a b.csv',
    });
    expect(await rawRows()).toHaveLength(0);
    const [row] = await db('crypto_csv_imports');
    expect(row).toMatchObject({ status: 'previewed', uploaded_by: 1 });
    expect(row.file_sha256).toBe(p.fileSha256);
  });

  it('commits 1,200 rows in batches inside one transaction', async () => {
    const buffer = rawTradingCsv(1200);
    const p = await preview.execute(connectionId, upload(buffer), 1);
    const spy = jest.spyOn(imports, 'insertIgnoringDuplicates');
    const txSpy = jest.spyOn(imports, 'inTransaction');

    const view = await commit.execute(p.importId, { buffer });

    expect(spy.mock.calls.map(([rows]) => rows.length)).toEqual([
      500, 500, 200,
    ]);
    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(view).toMatchObject({
      status: 'committed',
      rowCount: 1200,
      rowsImported: 1200,
      rowsSkippedDuplicate: 0,
    });
    const rows = await rawRows();
    expect(rows).toHaveLength(1200);
    expect(
      rows.every((r) => r.source === 'csv' && r.import_id === p.importId),
    ).toBe(true);
    const sample = rows[17];
    expect(sample.record_type).toBe('trade');
    const payload =
      typeof sample.payload === 'string'
        ? JSON.parse(sample.payload)
        : sample.payload;
    expect(payload).toMatchObject({ tax_id: 's_17', source: 'csv' });
    expect(sample.payload_hash).toBe(computePayloadHash(payload));
    expect(sample.exchange_record_id).toMatch(/^csv:[0-9a-f]{64}$/);
    const [imp] = await db('crypto_csv_imports');
    expect(imp.committed_at).not.toBeNull();
    expect(events.emitted.map((e) => e.name)).toEqual([
      'crypto.csv-import.committed',
    ]);
  });

  it('a failure on batch 2 leaves zero rows and marks the import failed', async () => {
    const buffer = rawTradingCsv(1200);
    const p = await preview.execute(connectionId, upload(buffer), 1);
    const original = imports.insertIgnoringDuplicates.bind(imports);
    let calls = 0;
    jest
      .spyOn(imports, 'insertIgnoringDuplicates')
      .mockImplementation(async (rows, trx) => {
        calls += 1;
        if (calls === 2) throw new Error('forced failure');
        return original(rows, trx);
      });

    await expect(commit.execute(p.importId, { buffer })).rejects.toThrow(
      'forced failure',
    );

    expect(calls).toBe(2);
    expect(await rawRows()).toHaveLength(0);
    const [imp] = await db('crypto_csv_imports');
    expect(imp).toMatchObject({ status: 'failed', rows_imported: 0 });
    expect(events.emitted).toHaveLength(0);
  });

  it('skips keys already stored (API or earlier import) without failing', async () => {
    const buffer = fixture('staking.csv');
    const plan = csv.plan('pionex', buffer);
    const [first] = plan.records;
    // an API row sharing the key of the first CSV row
    await db('crypto_raw_records').insert({
      connection_id: connectionId,
      record_type: first.record.recordType,
      exchange_record_id: first.exchangeRecordId,
      occurred_at: first.record.occurredAt,
      payload: JSON.stringify({ api: true }),
      payload_hash: 'x'.repeat(64),
    });

    const p = await preview.execute(connectionId, upload(buffer), 1);
    expect(p).toMatchObject({ alreadyImported: 1, importable: 2 });
    const view = await commit.execute(p.importId, { buffer });

    expect(view).toMatchObject({ rowsImported: 2, rowsSkippedDuplicate: 1 });
    const rows = await rawRows();
    expect(rows).toHaveLength(3);
    const apiRow = rows.find(
      (r) => r.exchange_record_id === first.exchangeRecordId,
    );
    expect(apiRow).toMatchObject({ source: 'api', import_id: null });
    expect(JSON.stringify(apiRow.payload)).toContain('api');
    expect(rows.filter((r) => r.import_id === p.importId)).toHaveLength(2);
  });

  it('the same key under a different record type does not collide', async () => {
    const trx = await modelDb.transaction();
    const base = {
      connectionId,
      exchangeRecordId: 'csv:same',
      occurredAt: new Date('2020-01-01T00:00:00Z'),
      payload: '{}',
      payloadHash: 'h'.repeat(64),
      source: 'csv' as const,
      importId: (
        await imports.insertImport({
          connectionId,
          exchange: 'pionex',
          reportType: 'x',
          originalFilename: 'x.csv',
          fileSha256: 'a'.repeat(64),
          status: 'previewed',
        })
      ).id,
    };
    const inserted = await imports.insertIgnoringDuplicates(
      [
        { ...base, recordType: 'trade' },
        { ...base, recordType: 'funding' },
        { ...base, recordType: 'trade' }, // exact duplicate inside the batch
      ],
      trx,
    );
    await trx.commit();
    expect(inserted).toBe(2);
    expect(await rawRows()).toHaveLength(2);
  });

  it('two overlapping files import each id once; rolling back the second keeps the first', async () => {
    const a = fixture('trading.csv');
    const extra =
      '"2020-01-04 00:00:00","1","2","3","BUY","TEST_USDT","0.1","TEST","Spot","s_t9"\n';
    const b = Buffer.concat([a, Buffer.from(extra)]);
    const first = await previewAndCommit(a);
    const second = await previewAndCommit(b);
    expect(first.view.rowsImported).toBe(2);
    expect(second.view).toMatchObject({
      rowsImported: 1,
      rowsSkippedDuplicate: 2,
    });
    expect(await rawRows()).toHaveLength(3);

    await rollback.execute(second.p.importId);

    const left = await rawRows();
    expect(left).toHaveLength(2);
    expect(left.every((r) => r.import_id === first.p.importId)).toBe(true);
  });

  it('rolling back A leaves B and the API rows', async () => {
    await db('crypto_raw_records').insert({
      connection_id: connectionId,
      record_type: 'trade',
      exchange_record_id: 'api-1',
      occurred_at: new Date('2020-01-02T10:00:00Z'),
      payload: '{}',
      payload_hash: 'h'.repeat(64),
    });
    const a = await previewAndCommit(fixture('trading.csv'));
    const b = await previewAndCommit(fixture('others.csv'));
    expect(await rawRows()).toHaveLength(1 + 2 + 3);

    const view = await rollback.execute(a.p.importId);

    expect(view.status).toBe('rolled_back');
    expect(await rawRows({ import_id: a.p.importId })).toHaveLength(0);
    expect(await rawRows({ import_id: b.p.importId })).toHaveLength(3);
    expect(await rawRows({ source: 'api' })).toHaveLength(1);
    // the file can be previewed and imported again
    const again = await previewAndCommit(fixture('trading.csv'));
    expect(again.view.rowsImported).toBe(2);
  });

  it('rolls back chunks above the delete chunk size', async () => {
    const { p } = await previewAndCommit(rawTradingCsv(1200));
    const view = await rollback.execute(p.importId);
    expect(view.status).toBe('rolled_back');
    expect(await rawRows()).toHaveLength(0);
  });

  it('refuses a duplicate file once committed and non-committed rollbacks', async () => {
    const { p } = await previewAndCommit(fixture('trading.csv'));
    await expect(
      preview.execute(connectionId, upload(fixture('trading.csv')), 1),
    ).rejects.toMatchObject({ code: 'CSV_DUPLICATE_FILE' });
    await rollback.execute(p.importId);
    await expect(rollback.execute(p.importId)).rejects.toMatchObject({
      code: 'CSV_NOT_ROLLBACKABLE',
    });
  });

  it('only one of two concurrent commits of the same import wins', async () => {
    const buffer = rawTradingCsv(50);
    const p = await preview.execute(connectionId, upload(buffer), 1);
    const results = await Promise.allSettled([
      commit.execute(p.importId, { buffer }),
      commit.execute(p.importId, { buffer }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as
      | PromiseRejectedResult
      | undefined;
    expect(rejected?.reason).toMatchObject({ code: 'CSV_NOT_COMMITTABLE' });
    expect(await rawRows()).toHaveLength(50);
  });

  it('apiOverlap counts API trades in range; abandoned previews are purged', async () => {
    await db('crypto_raw_records').insert([
      {
        connection_id: connectionId,
        record_type: 'trade',
        exchange_record_id: 'in',
        occurred_at: new Date('2020-01-02T10:00:00Z'),
        payload: '{}',
        payload_hash: 'h'.repeat(64),
      },
      {
        connection_id: connectionId,
        record_type: 'trade',
        exchange_record_id: 'out',
        occurred_at: new Date('2021-01-02T10:00:00Z'),
        payload: '{}',
        payload_hash: 'h'.repeat(64),
      },
    ]);
    const old = await preview.execute(
      connectionId,
      upload(fixture('staking.csv')),
      1,
    );
    await db('crypto_csv_imports')
      .where({ id: old.importId })
      .update({ created_at: new Date(Date.now() - 25 * 3600 * 1000) });

    const p = await preview.execute(
      connectionId,
      upload(fixture('trading.csv')),
      1,
    );

    expect(p.apiOverlap).toBe(1);
    const ids = (await db('crypto_csv_imports')).map((r) => r.id);
    expect(ids).toEqual([p.importId]);
  });

  it('lists the history newest first', async () => {
    const a = await previewAndCommit(fixture('trading.csv'));
    const b = await preview.execute(
      connectionId,
      upload(fixture('staking.csv')),
      1,
    );
    const views = await list.execute(connectionId);
    expect(views.map((v) => v.id)).toEqual([b.importId, a.p.importId]);
    expect(views[1].dateFrom).toBe('2020-01-02T03:04:05.000Z');
  });

  describe('foreign keys', () => {
    it('hard-deleting a connection cascades previews, imports and rows', async () => {
      const kept = await addConnection({ label: 'other' });
      await previewAndCommit(fixture('trading.csv'));
      await previewAndCommit(fixture('staking.csv'));
      const pending = await preview.execute(
        connectionId,
        upload(fixture('others.csv')),
        1,
      );
      await previewAndCommit(fixture('trading.csv'), kept);
      expect(
        await db('crypto_csv_imports').where({ id: pending.importId }),
      ).toHaveLength(1);

      await db('crypto_connections').where({ id: connectionId }).delete();

      expect(
        await db('crypto_csv_imports').where({ connection_id: connectionId }),
      ).toHaveLength(0);
      expect(await rawRows({ connection_id: connectionId })).toHaveLength(0);
      expect(await rawRows({ connection_id: kept })).toHaveLength(2);
      expect(
        await db('crypto_csv_imports').where({ connection_id: kept }),
      ).toHaveLength(1);
    });

    it('deleting an import row nulls import_id on its raw rows (SET NULL)', async () => {
      const { p } = await previewAndCommit(fixture('trading.csv'));
      await db('crypto_csv_imports').where({ id: p.importId }).delete();
      const rows = await rawRows();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.import_id === null)).toBe(true);
    });

    it('commit refuses an archived connection and writes nothing', async () => {
      const buffer = fixture('trading.csv');
      const p = await preview.execute(connectionId, upload(buffer), 1);
      await db('crypto_connections')
        .where({ id: connectionId })
        .update({ deleted_at: new Date() });
      await expect(
        commit.execute(p.importId, { buffer }),
      ).rejects.toMatchObject({ errorType: 'CRYPTO_CONNECTION_NOT_FOUND' });
      expect(await rawRows()).toHaveLength(0);
    });
  });
});
