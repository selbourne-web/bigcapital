import knex, { Knex } from 'knex';

/**
 * Integration test for the crypto tenant schema. Needs a throwaway database
 * that already has the tenant  table. It is skipped unless
 * TEST_TENANT_DB is set, and refuses any database whose name does not contain
 * "scratch" or "test" so it can never run against a real tenant database.
 * Connection settings come from DB_HOST / DB_USER / DB_PASSWORD / DB_PORT.
 */
const dbName = process.env.TEST_TENANT_DB;
const suite = dbName ? describe : describe.skip;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const migration = () =>
  require('../../database/tenant/migrations/20261004000000_create_crypto_exchange_tables');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const csvMigration = () =>
  require('../../database/tenant/migrations/20261008000000_create_crypto_csv_imports');

suite('Crypto exchange tenant schema (integration)', () => {
  let db: Knex;
  let accountId: number;
  const record = (connectionId: number) => ({
    connection_id: connectionId,
    record_type: 'trade',
    exchange_record_id: 'T-1',
    occurred_at: new Date('2026-01-01T00:00:00Z'),
    payload: JSON.stringify({ a: 1 }),
    payload_hash: 'a'.repeat(64),
  });
  const connection = (extra: Record<string, unknown> = {}) => ({
    exchange: 'kraken',
    label: 'Kraken - Trading',
    api_key_encrypted: 'k',
    api_secret_encrypted: 's',
    ...extra,
  });

  beforeAll(async () => {
    if (!/scratch|test/i.test(dbName)) {
      throw new Error(`Refusing to run against database "${dbName}".`);
    }
    db = knex({
      client: 'mysql2',
      connection: {
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: dbName,
      },
    });
    await csvMigration().down(db);
    await migration().down(db);
    await migration().up(db);
    await csvMigration().up(db);
    [accountId] = await db('accounts').insert({ name: 'Crypto' });
  });

  afterAll(async () => {
    if (db) {
      await csvMigration().down(db);
      await migration().down(db);
      await db('accounts').where({ id: accountId }).delete();
      await db.destroy();
    }
  });

  it('creates the four crypto tables', async () => {
    for (const t of [
      'crypto_connections',
      'crypto_raw_records',
      'crypto_balance_snapshots',
      'crypto_sync_runs',
    ]) {
      expect(await db.schema.hasTable(t)).toBe(true);
    }
  });

  it('rejects a duplicate (connection_id, record_type, exchange_record_id)', async () => {
    const [connId] = await db('crypto_connections').insert(connection());
    await db('crypto_raw_records').insert(record(connId));
    await expect(
      db('crypto_raw_records').insert(record(connId)),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
  });

  it('rejects two connections mapped to the same account', async () => {
    await db('crypto_connections').insert(
      connection({ account_id: accountId }),
    );
    await expect(
      db('crypto_connections').insert(connection({ account_id: accountId })),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
  });

  it('allows several unmapped connections (null account_id)', async () => {
    await db('crypto_connections').insert(connection());
    await db('crypto_connections').insert(connection());
  });

  it('rejects deleting an account that is mapped to a connection', async () => {
    const [id] = await db('accounts').insert({ name: 'Mapped' });
    await db('crypto_connections').insert(connection({ account_id: id }));
    await expect(db('accounts').where({ id }).delete()).rejects.toMatchObject({
      code: 'ER_ROW_IS_REFERENCED_2',
    });
  });

  describe('CSV import tables', () => {
    const csvImport = (connectionId: number) => ({
      connection_id: connectionId,
      exchange: 'pionex',
      report_type: 'raw-trading-details',
      original_filename: 'a.csv',
      file_sha256: 'b'.repeat(64),
      status: 'committed',
    });

    it('defaults crypto_connections.mode to api', async () => {
      const [connId] = await db('crypto_connections').insert(connection());
      const row = await db('crypto_connections').where({ id: connId }).first();
      expect(row.mode).toBe('api');
    });

    it('defaults raw record source to api with a null import_id', async () => {
      const [connId] = await db('crypto_connections').insert(connection());
      const [id] = await db('crypto_raw_records').insert(record(connId));
      const row = await db('crypto_raw_records').where({ id }).first();
      expect(row.source).toBe('api');
      expect(row.import_id).toBeNull();
    });

    it('rejects a raw record pointing at a nonexistent import', async () => {
      const [connId] = await db('crypto_connections').insert(connection());
      await expect(
        db('crypto_raw_records').insert({
          ...record(connId),
          source: 'csv',
          import_id: 999999,
        }),
      ).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' });
    });

    it('sets import_id to null on the rows of a deleted import', async () => {
      const [connId] = await db('crypto_connections').insert(connection());
      const [importId] = await db('crypto_csv_imports').insert(
        csvImport(connId),
      );
      const [rowId] = await db('crypto_raw_records').insert({
        ...record(connId),
        source: 'csv',
        import_id: importId,
      });
      await db('crypto_csv_imports').where({ id: importId }).delete();
      const row = await db('crypto_raw_records').where({ id: rowId }).first();
      expect(row.import_id).toBeNull();
      expect(row.source).toBe('csv');
    });

    it('cascades imports with their connection and allows re-importing the same hash', async () => {
      const [connId] = await db('crypto_connections').insert(connection());
      await db('crypto_csv_imports').insert(csvImport(connId));
      await db('crypto_csv_imports').insert({
        ...csvImport(connId),
        status: 'rolled_back',
      });
      await db('crypto_connections').where({ id: connId }).delete();
      const left = await db('crypto_csv_imports').where({
        connection_id: connId,
      });
      expect(left).toHaveLength(0);
    });
  });
});
