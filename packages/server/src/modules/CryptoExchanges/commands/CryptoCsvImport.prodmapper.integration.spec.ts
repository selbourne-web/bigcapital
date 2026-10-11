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
import { FakeAudit, FakeEvents, fakeCls } from './testFakes';

/**
 * Integration spec that mirrors PRODUCTION knex: the tenant connection uses
 * `knexSnakeCaseMappers({ upperCase: true })` and charset `utf8`, so tables and
 * columns are UPPERCASE (CRYPTO_RAW_RECORDS, CONNECTION_ID, ...) and the
 * connection is utf8mb3. The tables are created by running the real migrations
 * through that same knex. On a case-sensitive server (lower_case_table_names=0,
 * like the dev MariaDB) these tables sit beside the lowercase ones of the other
 * specs. Skipped unless TEST_TENANT_DB is set; refuses non-"scratch_" names.
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
/** "others" report: `comment` is free text. */
const othersCsv = (comments: string[]): Buffer =>
  Buffer.from(
    '"date(UTC+0)","coin","amount","tag","comment"\n' +
      comments
        .map(
          (c, i) =>
            `"2020-01-01 00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}","USDT","1","FundingFee","${c}"`,
        )
        .join('\n') +
      '\n',
  );
const extraRow = (n: number) =>
  Buffer.from(
    `"2020-01-0${n} 00:00:00","1","2","3","BUY","TEST_USDT","0.1","TEST","Spot","s_x${n}"\n`,
  );
const upload = (buffer: Buffer, originalname = 'trading.csv') => ({
  buffer,
  originalname,
});

suite('Crypto CSV import (integration, production knex mapper)', () => {
  jest.setTimeout(180_000);
  let db: Knex; // production-style: upperCase snake mapper, charset utf8
  let plain: Knex;
  let imports: CryptoCsvImportRepository;
  let preview: PreviewCryptoCsvImportService;
  let commit: CommitCryptoCsvImportService;
  let rollback: RollbackCryptoCsvImportService;
  let audit: FakeAudit;
  let events: FakeEvents;
  let connectionId: number;
  let caseSensitive = false;

  const addConnection = async (label = 'Pionex') => {
    const [id] = await db('crypto_connections').insert({
      exchange: 'pionex',
      label,
      apiKeyEncrypted: 'k',
      apiSecretEncrypted: 's',
    });
    return id as number;
  };
  const rawRows = (where: Record<string, unknown> = {}) =>
    db('crypto_raw_records').where(where).orderBy('id');
  const previewAndCommit = async (buffer: Buffer, id = connectionId) => {
    const p = await preview.execute(id, upload(buffer), 1);
    return { p, view: await commit.execute(p.importId, { buffer }) };
  };

  beforeAll(async () => {
    if (!dbName.startsWith('scratch_')) {
      throw new Error(`Refusing to run against database "${dbName}".`);
    }
    const base = {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: dbName,
    };
    // same shape as TenancyDB.module.ts
    db = knex({
      client: 'mysql2',
      connection: { ...base, charset: 'utf8' },
      ...knexSnakeCaseMappers({ upperCase: true }),
    });
    plain = knex({ client: 'mysql2', connection: base });
    const [[lc]] = await plain.raw('select @@lower_case_table_names as v');
    caseSensitive = Number(lc.v) === 0;

    for (const t of [
      'crypto_sync_runs',
      'crypto_balance_snapshots',
      'crypto_raw_records',
      'crypto_csv_imports',
      'crypto_connections',
      'accounts',
    ]) {
      await db.schema.dropTableIfExists(t);
    }
    // the crypto migration references accounts(id)
    await db.schema.createTable('accounts', (t) => {
      t.increments('id');
    });
    for (const m of migrations()) await m.up(db);
    CryptoConnection.knex(db);
    CryptoRawRecord.knex(db);
    CryptoCsvImport.knex(db);

    const connections = new CryptoConnectionRepository(() => CryptoConnection);
    imports = new CryptoCsvImportRepository(
      () => CryptoCsvImport,
      () => CryptoRawRecord,
    );
    const csv = new CsvImportService(new CsvParserRegistry(PIONEX_CSV_PARSERS));
    audit = new FakeAudit();
    events = new FakeEvents();
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
  });

  afterAll(async () => {
    if (db) {
      // The migrations' down() guards use hasTable/hasColumn, which compare
      // unmapped lowercase names and see nothing on a case-sensitive server, so
      // drop explicitly (children first).
      for (const t of [
        'crypto_raw_records',
        'crypto_csv_imports',
        'crypto_sync_runs',
        'crypto_balance_snapshots',
        'crypto_connections',
        'accounts',
      ]) {
        await db.schema.dropTableIfExists(t);
      }
      await db.destroy();
      await plain.destroy();
    }
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    audit.rows = [];
    audit.failWith = undefined;
    events.emitted = [];
    (commit as any).insertMaxBytes = 4 * 1024 * 1024;
    (imports as any).deleteChunk = 5000;
    for (const t of [
      'crypto_raw_records',
      'crypto_csv_imports',
      'crypto_connections',
    ]) {
      await db(t).delete();
    }
    connectionId = await addConnection();
  });

  it('really runs on uppercase identifiers', async () => {
    const [rows] = await plain.raw(
      "select table_name as n from information_schema.tables where table_schema = ? and table_name like 'CRYPTO\\_%'",
      [dbName],
    );
    const names = rows.map((r: any) => r.n ?? r.N);
    if (caseSensitive) {
      expect(names).toEqual(
        expect.arrayContaining(['CRYPTO_RAW_RECORDS', 'CRYPTO_CSV_IMPORTS']),
      );
    }
    const [cols] = await plain.raw(
      "select column_name as c from information_schema.columns where table_schema = ? and table_name = 'CRYPTO_RAW_RECORDS' and column_name = 'IMPORT_ID'",
      [dbName],
    );
    if (caseSensitive) expect(cols).toHaveLength(1);
  });

  it('previews, commits 1,200 rows in batches and rolls back under the production mapper', async () => {
    const buffer = rawTradingCsv(1200);
    const p = await preview.execute(connectionId, upload(buffer), 1);
    const spy = jest.spyOn(imports, 'insertIgnoringDuplicates');
    const view = await commit.execute(p.importId, { buffer });

    expect(spy.mock.calls.map(([r]) => r.length)).toEqual([500, 500, 200]);
    expect(view).toMatchObject({
      status: 'committed',
      rowsImported: 1200,
      rowsSkippedDuplicate: 0,
    });
    const rows = await rawRows();
    expect(rows).toHaveLength(1200);
    expect(
      rows.every((r) => r.source === 'csv' && r.importId === p.importId),
    ).toBe(true);
    const payload =
      typeof rows[3].payload === 'string'
        ? JSON.parse(rows[3].payload)
        : rows[3].payload;
    expect(rows[3].payloadHash).toBe(computePayloadHash(payload));

    // a second preview of the same bytes: committed -> duplicate file
    await expect(
      preview.execute(connectionId, upload(buffer), 1),
    ).rejects.toMatchObject({ code: 'CSV_DUPLICATE_FILE' });

    const rolled = await rollback.execute(p.importId);
    expect(rolled.status).toBe('rolled_back');
    expect(await rawRows()).toHaveLength(0);
  });

  it('rollback deletes in several chunks (chunk size lowered to 500)', async () => {
    const { p } = await previewAndCommit(rawTradingCsv(1200));
    (imports as any).deleteChunk = 500;
    const deletes: string[] = [];
    const listener = (q: { sql: string }) => {
      if (/^delete from/i.test(q.sql)) deletes.push(q.sql);
    };
    db.on('query', listener);
    await rollback.execute(p.importId);
    db.removeListener('query', listener);
    expect(deletes.length).toBe(3);
    expect(await rawRows()).toHaveLength(0);
  });

  it('splits INSERT statements by payload bytes as well as rows', async () => {
    const buffer = othersCsv(
      Array.from({ length: 40 }, () => 'y'.repeat(1900)),
    );
    (commit as any).insertMaxBytes = 20_000;
    const p = await preview.execute(connectionId, upload(buffer), 1);
    const spy = jest.spyOn(imports, 'insertIgnoringDuplicates');
    await commit.execute(p.importId, { buffer });
    const sizes = spy.mock.calls.map(([r]) => r.length);
    expect(sizes.length).toBeGreaterThan(3);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(10);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(40);
    expect(await rawRows()).toHaveLength(40);
  });

  describe('warnings are never swallowed (INSERT IGNORE)', () => {
    it('a 4-byte character (emoji) is stored losslessly or the commit fails closed: never altered', async () => {
      const buffer = othersCsv(['fine', 'party 🎉 time', 'also fine']);
      const p = await preview.execute(connectionId, upload(buffer), 1);
      const outcome = await commit.execute(p.importId, { buffer }).then(
        () => 'stored',
        () => 'refused',
      );
      const rows = await rawRows();
      if (outcome === 'stored') {
        expect(rows).toHaveLength(3);
        const texts = rows.map((r) =>
          typeof r.payload === 'string' ? r.payload : JSON.stringify(r.payload),
        );
        expect(texts.some((t) => t.includes('🎉'))).toBe(true);
        for (const r of rows) {
          const payload =
            typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
          expect(r.payloadHash).toBe(computePayloadHash(payload));
        }
      } else {
        expect(rows).toHaveLength(0);
        const [imp] = await db('crypto_csv_imports').where({ id: p.importId });
        expect(imp.status).toBe('failed');
        expect(audit.rows).toHaveLength(0);
      }
    });

    it('a value longer than its column cannot be truncated through the insert helper', async () => {
      const [importId] = await db('crypto_csv_imports').insert({
        connectionId,
        exchange: 'pionex',
        reportType: 'x',
        originalFilename: 'x.csv',
        fileSha256: 'a'.repeat(64),
        status: 'previewed',
      });
      const row = {
        connectionId,
        recordType: 'x'.repeat(40), // varchar(16)
        exchangeRecordId: 'csv:t',
        occurredAt: new Date('2020-01-01T00:00:00Z'),
        payload: '{}',
        payloadHash: 'h'.repeat(64),
        source: 'csv' as const,
        importId,
      };
      const trx = await db.transaction();
      await expect(
        imports.insertIgnoringDuplicates([row], trx),
      ).rejects.toThrow();
      await trx.rollback();
      expect(await rawRows()).toHaveLength(0);
    });

    it('under non-strict sql_mode the truncation is only a warning, and the helper still aborts', async () => {
      const [importId] = await db('crypto_csv_imports').insert({
        connectionId,
        exchange: 'pionex',
        reportType: 'x',
        originalFilename: 'x.csv',
        fileSha256: 'c'.repeat(64),
        status: 'previewed',
      });
      const trx = await db.transaction();
      const [[mode]] = await trx.raw('select @@sql_mode as m');
      await trx.raw("SET SESSION sql_mode = ''");
      try {
        await expect(
          imports.insertIgnoringDuplicates(
            [
              {
                connectionId,
                recordType: 'x'.repeat(40), // varchar(16): silently cut in non-strict mode
                exchangeRecordId: 'csv:w',
                occurredAt: new Date('2020-01-01T00:00:00Z'),
                payload: '{}',
                payloadHash: 'h'.repeat(64),
                source: 'csv',
                importId,
              },
            ],
            trx,
          ),
        ).rejects.toThrow(/unexpected warnings.*1265/);
      } finally {
        await trx.raw('SET SESSION sql_mode = ?', [mode.m ?? mode.M ?? '']);
        await trx.rollback();
      }
      expect(await rawRows()).toHaveLength(0);
    });

    it('duplicate keys alone are fine and counted exactly', async () => {
      const [importId] = await db('crypto_csv_imports').insert({
        connectionId,
        exchange: 'pionex',
        reportType: 'x',
        originalFilename: 'x.csv',
        fileSha256: 'b'.repeat(64),
        status: 'previewed',
      });
      const row = (id: string) => ({
        connectionId,
        recordType: 'trade',
        exchangeRecordId: id,
        occurredAt: new Date('2020-01-01T00:00:00Z'),
        payload: '{}',
        payloadHash: 'h'.repeat(64),
        source: 'csv' as const,
        importId,
      });
      const trx = await db.transaction();
      const first = await imports.insertIgnoringDuplicates(
        [row('a'), row('b')],
        trx,
      );
      const second = await imports.insertIgnoringDuplicates(
        [row('a'), row('b'), row('c')],
        trx,
      );
      await trx.commit();
      expect([first, second]).toEqual([2, 1]);
    });
  });

  describe('per-connection serialisation', () => {
    it('two previews of one file committed concurrently: one wins, the other is CSV_DUPLICATE_FILE', async () => {
      const buffer = rawTradingCsv(300);
      const a = await preview.execute(connectionId, upload(buffer), 1);
      const b = await preview.execute(connectionId, upload(buffer), 1);

      const results = await Promise.allSettled([
        commit.execute(a.importId, { buffer }),
        commit.execute(b.importId, { buffer }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult;
      expect(lost.reason).toMatchObject({ code: 'CSV_DUPLICATE_FILE' });
      expect(await rawRows()).toHaveLength(300);
      const committed = await db('crypto_csv_imports').where({
        status: 'committed',
      });
      expect(committed).toHaveLength(1);
      expect(audit.rows).toHaveLength(1);
    });

    it('the same file on two different connections imports independently', async () => {
      const other = await addConnection('Other');
      const buffer = fixture('trading.csv');
      const [x, y] = await Promise.all([
        previewAndCommit(buffer, connectionId),
        previewAndCommit(buffer, other),
      ]);
      expect(x.view.rowsImported).toBe(2);
      expect(y.view.rowsImported).toBe(2);
      expect(await rawRows({ connectionId })).toHaveLength(2);
      expect(await rawRows({ connectionId: other })).toHaveLength(2);
    });

    it('overlapping files committed concurrently store each id once', async () => {
      const a = fixture('trading.csv');
      const b = Buffer.concat([a, extraRow(4)]);
      const pa = await preview.execute(connectionId, upload(a), 1);
      const pb = await preview.execute(connectionId, upload(b), 1);
      const [va, vb] = await Promise.all([
        commit.execute(pa.importId, { buffer: a }),
        commit.execute(pb.importId, { buffer: b }),
      ]);
      expect(await rawRows()).toHaveLength(3);
      expect(va.rowsImported + vb.rowsImported).toBe(3);
      expect(va.rowsImported + va.rowsSkippedDuplicate).toBe(2);
      expect(vb.rowsImported + vb.rowsSkippedDuplicate).toBe(3);
    });

    it('a rollback waits for a running commit on the same connection', async () => {
      const first = await previewAndCommit(fixture('trading.csv'));
      const buffer = rawTradingCsv(400);
      const p = await preview.execute(connectionId, upload(buffer), 1);
      await Promise.all([
        commit.execute(p.importId, { buffer }),
        rollback.execute(first.p.importId),
      ]);
      expect(await rawRows({ importId: first.p.importId })).toHaveLength(0);
      expect(await rawRows({ importId: p.importId })).toHaveLength(400);
    });
  });

  describe('rollback dependency guard', () => {
    it('refuses A while a later overlapping import skipped rows, then allows it after B is rolled back', async () => {
      const a = fixture('trading.csv');
      const b = Buffer.concat([a, extraRow(4)]);
      const first = await previewAndCommit(a);
      const second = await previewAndCommit(b);
      expect(second.view.rowsSkippedDuplicate).toBe(2);

      const error = await rollback.execute(first.p.importId).catch((e) => e);
      expect(error).toMatchObject({
        code: 'CSV_NOT_ROLLBACKABLE',
        details: { dependentImportIds: [second.p.importId] },
      });
      expect(await rawRows()).toHaveLength(3);

      await rollback.execute(second.p.importId);
      await rollback.execute(first.p.importId);
      expect(await rawRows()).toHaveLength(0);
    });

    it('an unrelated later import does not block', async () => {
      const first = await previewAndCommit(fixture('trading.csv'));
      await previewAndCommit(fixture('others.csv'));
      await expect(rollback.execute(first.p.importId)).resolves.toMatchObject({
        status: 'rolled_back',
      });
    });
  });

  it('audit rows are written with the commit and rolled back with a failing audit', async () => {
    const buffer = fixture('trading.csv');
    const p = await preview.execute(connectionId, upload(buffer), 1);
    audit.failWith = new Error('audit down');
    await expect(commit.execute(p.importId, { buffer })).rejects.toThrow(
      'audit down',
    );
    expect(await rawRows()).toHaveLength(0);

    audit.failWith = undefined;
    const q = await preview.execute(connectionId, upload(buffer), 1);
    await commit.execute(q.importId, { buffer });
    expect(audit.rows.map((r) => r.action)).toEqual(['csv_imported']);
    expect(await rawRows()).toHaveLength(2);
  });

  it('commit order, not preview order, drives the guard (B previewed first, A committed first, same second)', async () => {
    const a = fixture('trading.csv');
    const b = Buffer.concat([a, extraRow(4)]);
    const pb = await preview.execute(connectionId, upload(b), 1); // lower id
    const pa = await preview.execute(connectionId, upload(a), 1); // higher id
    expect(pb.importId).toBeLessThan(pa.importId);

    await commit.execute(pa.importId, { buffer: a });
    const vb = await commit.execute(pb.importId, { buffer: b }); // back-to-back
    expect(vb.rowsSkippedDuplicate).toBe(2);

    const [ra] = await db('crypto_csv_imports').where({ id: pa.importId });
    const [rb] = await db('crypto_csv_imports').where({ id: pb.importId });
    // microsecond column: stored strictly after, even inside one second
    const [[order]] = await plain.raw(
      'select (b.COMMITTED_AT > a.COMMITTED_AT) as later from CRYPTO_CSV_IMPORTS a, CRYPTO_CSV_IMPORTS b where a.ID = ? and b.ID = ?',
      [pa.importId, pb.importId],
    );
    expect(Number(order.later)).toBe(1);
    expect(ra.committedAt).toBeTruthy();
    expect(rb.committedAt).toBeTruthy();

    const error = await rollback.execute(pa.importId).catch((e) => e);
    expect(error).toMatchObject({
      code: 'CSV_NOT_ROLLBACKABLE',
      details: { dependentImportIds: [pb.importId] },
    });
    expect(await rawRows()).toHaveLength(3);

    await rollback.execute(pb.importId); // B is not blocked by A
    await rollback.execute(pa.importId);
    expect(await rawRows()).toHaveLength(0);
  });

  it('aborts rather than passes when the warning list is truncated by a tiny max_error_count', async () => {
    const [importId] = await db('crypto_csv_imports').insert({
      connectionId,
      exchange: 'pionex',
      reportType: 'x',
      originalFilename: 'x.csv',
      fileSha256: 'd'.repeat(64),
      status: 'previewed',
    });
    const mk = (id: string) => ({
      connectionId,
      recordType: 'trade',
      exchangeRecordId: id,
      occurredAt: new Date('2020-01-01T00:00:00Z'),
      payload: '{}',
      payloadHash: 'h'.repeat(64),
      source: 'csv' as const,
      importId,
    });
    const seed = await db.transaction();
    await imports.insertIgnoringDuplicates([mk('a'), mk('b'), mk('c')], seed);
    await seed.commit();

    const trx = await db.transaction();
    // a transaction whose SET SESSION max_error_count is forced down to 1
    const squeezed: any = new Proxy(trx, {
      get(target: any, prop) {
        if (prop === 'raw') {
          return (sql: string, ...rest: any[]) =>
            target.raw(
              /^SET SESSION max_error_count/.test(sql)
                ? 'SET SESSION max_error_count = 1'
                : sql,
              ...rest,
            );
        }
        return Reflect.get(target, prop, target);
      },
    });
    try {
      await expect(
        imports.insertIgnoringDuplicates(
          [mk('a'), mk('b'), mk('c'), mk('d')],
          squeezed,
        ),
      ).rejects.toThrow(/CSV import aborted/);
    } finally {
      await trx.raw('SET SESSION max_error_count = 64');
      await trx.rollback();
    }
    expect(await rawRows()).toHaveLength(3);
  });
});
