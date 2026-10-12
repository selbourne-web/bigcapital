import { readFileSync } from 'fs';
import { join } from 'path';
import knex, { Knex } from 'knex';
import { knexSnakeCaseMappers } from 'objection';
import { Account } from '@/modules/Accounts/models/Account.model';
import { UnitOfWork } from '@/modules/Tenancy/TenancyDB/UnitOfWork.service';
import { CryptoConnection } from '../models/CryptoConnection';
import { CryptoRawRecord } from '../models/CryptoRawRecord';
import { CryptoCsvImport } from '../models/CryptoCsvImport';
import { AdapterRegistry } from '../adapters/AdapterRegistry';
import { CsvImportService } from '../csv/CsvImport.service';
import { CsvParserRegistry } from '../csv/CsvParserRegistry';
import { NEXO_CSV_PARSERS } from '../csv/parsers/nexo/nexo.parsers';
import { PIONEX_CSV_PARSERS } from '../csv/parsers/pionex/pionex.parsers';
import { GetCryptoConnectionsService } from '../queries/GetCryptoConnections.service';
import { CryptoSyncRequestService } from '../sync/CryptoSyncRequest.service';
import { CryptoConnectionRepository } from './CryptoConnection.repository';
import { CryptoConnectionValidators } from './CryptoConnectionValidators.service';
import { CryptoCsvImportRepository } from './CryptoCsvImport.repository';
import { CreateCsvOnlyConnectionService } from './CreateCsvOnlyConnection.service';
import { DeleteCryptoConnectionService } from './DeleteCryptoConnection.service';
import { PreviewCryptoCsvImportService } from './PreviewCryptoCsvImport.service';
import { CommitCryptoCsvImportService } from './CommitCryptoCsvImport.service';
import { FakeAudit, FakeEvents, fakeCls } from './testFakes';

/**
 * CSV-only connections against a throwaway MariaDB database: the real
 * migrations (no new one: credential columns stay NOT NULL and hold ''), the
 * real repository, unit of work, validators and list query with the REAL
 * adapter registry, and the existing CSV preview/commit services with the
 * production parser registry composition. Skipped unless TEST_TENANT_DB is set;
 * refuses any name that does not start with "scratch_". The database needs an
 * `accounts` table. Connection settings come from DB_HOST / DB_USER /
 * DB_PASSWORD / DB_PORT.
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

/** UnitOfWork does not await commit/rollback; give them a moment to land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

const nexoFixture = () =>
  readFileSync(
    join(__dirname, '../csv/parsers/nexo/__fixtures__/transactions.csv'),
  );

suite('CSV-only connections (integration, scratch DB)', () => {
  jest.setTimeout(120_000);
  let db: Knex;
  let modelDb: Knex;
  let create: CreateCsvOnlyConnectionService;
  let remove: DeleteCryptoConnectionService;
  let list: GetCryptoConnectionsService;
  let preview: PreviewCryptoCsvImportService;
  let commit: CommitCryptoCsvImportService;
  let syncRequests: CryptoSyncRequestService;
  const audit = new FakeAudit();
  const events = new FakeEvents();
  const scheduler = {
    schedule: jest.fn(async () => undefined),
    enqueue: jest.fn(async () => undefined),
  };

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
    Account.knex(modelDb);

    const repo = new CryptoConnectionRepository(() => CryptoConnection);
    const tenancy = {
      getTenant: async () => ({ metadata: { baseCurrency: 'BBD' } }),
    } as any;
    const validators = new CryptoConnectionValidators(
      {
        get: () => {
          throw new Error('no adapter may be used for a csv_only connection');
        },
      } as any,
      { acquire: async () => undefined } as any,
      () => Account,
      repo,
      tenancy,
    );
    const uow = new UnitOfWork(() => modelDb);
    create = new CreateCsvOnlyConnectionService(
      repo,
      validators,
      uow,
      {
        createAccount: async () => {
          throw new Error('not used here');
        },
      } as any,
      audit as any,
    );
    remove = new DeleteCryptoConnectionService(
      repo,
      uow,
      audit as any,
      events as any,
      fakeCls(),
    );
    list = new GetCryptoConnectionsService(
      () => CryptoConnection,
      new AdapterRegistry(),
    );
    syncRequests = new CryptoSyncRequestService(
      repo,
      scheduler as any,
      { getOrThrow: () => ({}) } as any,
      { get: () => 'org-1' } as any,
    );
    const imports = new CryptoCsvImportRepository(
      () => CryptoCsvImport,
      () => CryptoRawRecord,
    );
    const csv = new CsvImportService(
      new CsvParserRegistry([...PIONEX_CSV_PARSERS, ...NEXO_CSV_PARSERS]),
    );
    preview = new PreviewCryptoCsvImportService(repo, imports, csv);
    commit = new CommitCryptoCsvImportService(
      repo,
      imports,
      csv,
      audit as any,
      events as any,
      fakeCls(),
    );
  });

  afterAll(async () => {
    if (db) {
      for (const m of [...migrations()].reverse()) await m.down(db);
      await db('accounts').delete();
      await db.destroy();
      await modelDb.destroy();
    }
  });

  beforeEach(async () => {
    audit.rows = [];
    scheduler.schedule.mockClear();
    scheduler.enqueue.mockClear();
    for (const t of [
      'crypto_raw_records',
      'crypto_csv_imports',
      'crypto_connections',
      'accounts',
    ]) {
      await db(t).delete();
    }
  });

  it('stores mode csv_only with empty (NOT NULL) credential columns, no migration needed', async () => {
    const view = await create.execute({ exchange: 'nexo', label: 'Nexo' });
    await settle();

    const [row] = await db('crypto_connections');
    expect(row).toMatchObject({
      id: view.id,
      exchange: 'nexo',
      label: 'Nexo',
      mode: 'csv_only',
      status: 'active',
      api_key_encrypted: '',
      api_secret_encrypted: '',
      passphrase_encrypted: null,
      key_hint: null,
      account_id: null,
      deleted_at: null,
    });
    expect(view).toMatchObject({ mode: 'csv_only', status: 'active' });
    expect(audit.rows[0].metadata).toMatchObject({ mode: 'csv_only' });
  });

  it('maps an existing asset account', async () => {
    const [accountId] = await db('accounts').insert({
      name: 'Nexo asset',
      account_type: 'bank',
      currency_code: 'BBD',
      active: 1,
    });
    const view = await create.execute({
      exchange: 'nexo',
      label: 'Nexo',
      accountId,
    });
    await settle();
    expect(view.accountId).toBe(accountId);
    const [row] = await db('crypto_connections');
    expect(row.account_id).toBe(accountId);
  });

  it('the list query returns the row with historyCoverage null (real registry) and self-heal schedules nothing', async () => {
    await create.execute({ exchange: 'nexo', label: 'Nexo' });
    await settle();

    const views = await list.execute();
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      exchange: 'nexo',
      mode: 'csv_only',
      historyCoverage: null,
    });
    expect(JSON.stringify(views)).not.toContain('apiKeyEncrypted');

    await syncRequests.selfHeal(views);
    expect(scheduler.schedule).not.toHaveBeenCalled();
    await expect(
      syncRequests.requestManualSync(views[0].id),
    ).rejects.toMatchObject({ errorType: 'CRYPTO_CONNECTION_CSV_ONLY' });
    expect(scheduler.enqueue).not.toHaveBeenCalled();
  });

  it('previews and commits a Nexo transactions file through the existing import services', async () => {
    const { id } = await create.execute({ exchange: 'nexo', label: 'Nexo' });
    await settle();
    const buffer = nexoFixture();

    const p = await preview.execute(
      id,
      { buffer, originalname: 'nexo.csv' },
      1,
    );
    expect(p).toMatchObject({ connectionId: id, exchange: 'nexo' });
    expect(p.importable).toBeGreaterThan(0);

    const view = await commit.execute(p.importId, { buffer });
    expect(view).toMatchObject({ status: 'committed' });
    const raw = await db('crypto_raw_records').where({ connection_id: id });
    expect(raw.length).toBe(p.importable);
    expect(new Set(raw.map((r) => r.source))).toEqual(new Set(['csv']));
  });

  it('delete (archive) works and hides the connection; its imported rows are kept', async () => {
    const { id } = await create.execute({ exchange: 'nexo', label: 'Nexo' });
    await settle();
    const buffer = nexoFixture();
    const p = await preview.execute(id, { buffer, originalname: 'n.csv' }, 1);
    await commit.execute(p.importId, { buffer });

    await remove.execute(id);
    await settle();

    const [row] = await db('crypto_connections').where({ id });
    expect(row.deleted_at).not.toBeNull();
    expect(row.api_key_encrypted).toBe('');
    expect(await list.execute()).toHaveLength(0);
    expect(
      (await db('crypto_raw_records').where({ connection_id: id })).length,
    ).toBe(p.importable);
  });
});
