import knex, { Knex } from 'knex';
import { knexSnakeCaseMappers } from 'objection';
import { CreateCryptoConnectionService } from './CreateCryptoConnection.service';
import { DeleteCryptoConnectionService } from './DeleteCryptoConnection.service';
import { CryptoConnectionRepository } from './CryptoConnection.repository';
import { CryptoConnectionValidators } from './CryptoConnectionValidators.service';
import { CreateAccountService } from '@/modules/Accounts/CreateAccount.service';
import { DeleteAccount } from '@/modules/Accounts/DeleteAccount.service';
import { Account } from '@/modules/Accounts/models/Account.model';
import { UnitOfWork } from '@/modules/Tenancy/TenancyDB/UnitOfWork.service';
import { CryptoConnection } from '../models/CryptoConnection';
import {
  FAKE_KEY,
  FAKE_PASSPHRASE,
  FAKE_SECRET,
  FakeAdapter,
  FakeAudit,
  FakeEvents,
  expectNoSecrets,
  fakeCls,
  makeVault,
} from './testFakes';

/**
 * Integration spec against a throwaway MariaDB database. Real: Objection models,
 * the unit of work, the migrations, CreateAccountService, the repository and the
 * validators. Faked: the exchange adapter, rate limiter, audit service, event
 * emitter, tenancy context and the account validators/settings of
 * CreateAccountService. Skipped unless TEST_TENANT_DB is set; refuses any name
 * that does not start with "scratch_". The database needs an `accounts` table.
 * Connection settings come from DB_HOST / DB_USER / DB_PASSWORD / DB_PORT.
 */
const dbName = process.env.TEST_TENANT_DB;
const suite = dbName ? describe : describe.skip;

const migrations = () => [
  require('../../../database/tenant/migrations/20261004000000_create_crypto_exchange_tables'),
  require('../../../database/tenant/migrations/20261004000100_add_sync_state_to_crypto_connections'),
  require('../../../database/tenant/migrations/20261004000200_add_deleted_at_to_crypto_connections'),
  require('../../../database/tenant/migrations/20261007000000_add_key_expires_at_to_crypto_connections'),
];

/** UnitOfWork does not await commit/rollback; give them a moment to land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

suite('Crypto connection commands (integration, scratch DB)', () => {
  jest.setTimeout(60_000); // DDL and first model use are slow on the shared dev VM
  let db: Knex;
  let modelDb: Knex;
  let repo: CryptoConnectionRepository;
  let audit: FakeAudit;
  let adapter: FakeAdapter;
  let create: CreateCryptoConnectionService;
  let remove: DeleteCryptoConnectionService;
  let validators: CryptoConnectionValidators;
  const vault = makeVault();
  const events = new FakeEvents();

  const dto = (extra: Record<string, unknown> = {}) =>
    ({
      exchange: 'kraken',
      label: 'Kraken - Trading',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
      passphrase: FAKE_PASSPHRASE,
      ...extra,
    }) as any;

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
    // Lower-case snake mapper: the scratch server is case-sensitive (see Task 6).
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
    Account.knex(modelDb);

    repo = new CryptoConnectionRepository(() => CryptoConnection);
    adapter = new FakeAdapter();
    audit = new FakeAudit();
    const tenancy = {
      getTenant: async () => ({ metadata: { baseCurrency: 'BBD' } }),
    } as any;
    validators = new CryptoConnectionValidators(
      { get: () => adapter } as any,
      { acquire: async () => undefined } as any,
      () => Account,
      repo,
      tenancy,
    );
    const uow = new UnitOfWork(() => modelDb);
    const createAccountService = new CreateAccountService(
      () => Account,
      events as any,
      uow,
      {
        validateAccountNameUniquiness: async () => undefined,
        getAccountTypeOrThrowError: () => undefined,
        validateAccountTypeSupportCurrency: () => undefined,
      } as any,
      tenancy,
      {
        getAccountsSettings: async () => ({
          accountCodeRequired: false,
          accountCodeUnique: false,
        }),
      } as any,
    );
    create = new CreateCryptoConnectionService(
      repo,
      vault,
      validators,
      uow,
      createAccountService,
      audit as any,
      events as any,
      fakeCls(),
    );
    remove = new DeleteCryptoConnectionService(
      repo,
      uow,
      audit as any,
      events as any,
      fakeCls(),
    );
  });

  afterAll(async () => {
    if (db) {
      const m = migrations();
      await m[3].down(db);
      await m[2].down(db);
      await m[1].down(db);
      await m[0].down(db);
      await db('accounts').delete();
      await db.destroy();
      await modelDb.destroy();
    }
  });

  beforeEach(async () => {
    audit.rows = [];
    audit.failWith = undefined;
    adapter.inspection = { readOnly: true, permissions: ['query'] };
    for (const t of [
      'crypto_sync_runs',
      'crypto_balance_snapshots',
      'crypto_raw_records',
      'crypto_connections',
      'accounts',
    ]) {
      await db(t).delete();
    }
  });

  const addAccount = async (extra: Record<string, unknown> = {}) => {
    const [id] = await db('accounts').insert({
      name: `Acc ${Math.random()}`,
      account_type: 'bank',
      currency_code: 'BBD',
      active: 1,
      ...extra,
    });
    return id as number;
  };

  it('createAccount:true inserts the asset account and the connection together', async () => {
    const view = await create.execute(dto({ createAccount: true }));
    await settle();

    const [account] = await db('accounts');
    expect(account).toMatchObject({
      name: 'Kraken - Trading',
      account_type: 'other-current-asset',
      currency_code: 'BBD',
    });
    expect(view.accountId).toBe(account.id);
    const [row] = await db('crypto_connections');
    expect(row.account_id).toBe(account.id);
    // credentials are stored only as ciphertext
    const raw = JSON.stringify(row);
    for (const s of [FAKE_KEY, FAKE_SECRET, FAKE_PASSPHRASE]) {
      expect(raw).not.toContain(s);
    }
    expect(vault.decrypt(row.api_key_encrypted, row.key_version)).toBe(
      FAKE_KEY,
    );
    expect(row.key_hint).toBe('7731');
    expectNoSecrets(view, audit.rows);
  });

  it('rolls the new account back when a later step of the transaction fails', async () => {
    audit.failWith = new Error('audit down');

    await expect(create.execute(dto({ createAccount: true }))).rejects.toThrow(
      'audit down',
    );
    await settle();

    expect(await db('accounts')).toHaveLength(0);
    expect(await db('crypto_connections')).toHaveLength(0);
  });

  it('stores nothing when the account insert fails', async () => {
    // the account insert fails inside CreateAccountService (name longer than its column)
    await expect(
      create.execute(dto({ createAccount: true, label: 'x'.repeat(300) })),
    ).rejects.toThrow();
    await settle();
    expect(await db('accounts')).toHaveLength(0);
    expect(await db('crypto_connections')).toHaveLength(0);
  });

  it('maps an existing asset account once; the unique index backs the check', async () => {
    const accountId = await addAccount();
    await create.execute(dto({ accountId }));
    await settle();

    await expect(
      create.execute(dto({ accountId, label: 'Second' })),
    ).rejects.toMatchObject({ errorType: 'CRYPTO_ACCOUNT_ALREADY_MAPPED' });

    // bypass the pre-check: the DB constraint is translated to the same error
    await expect(
      db('crypto_connections')
        .insert({
          exchange: 'kraken',
          label: 'dup',
          api_key_encrypted: 'k',
          api_secret_encrypted: 's',
          account_id: accountId,
        })
        .catch((e) => validators.rethrowIfDuplicateAccount(e)),
    ).rejects.toMatchObject({ errorType: 'CRYPTO_ACCOUNT_ALREADY_MAPPED' });
  });

  it('rejects non-asset and other-currency accounts (real Account model)', async () => {
    const liability = await addAccount({ account_type: 'credit-card' });
    const usd = await addAccount({ currency_code: 'USD' });

    await expect(
      create.execute(dto({ accountId: liability })),
    ).rejects.toMatchObject({ errorType: 'CRYPTO_ACCOUNT_NOT_ASSET' });
    await expect(create.execute(dto({ accountId: usd }))).rejects.toMatchObject(
      { errorType: 'CRYPTO_ACCOUNT_CURRENCY_MISMATCH' },
    );
    expect(await db('crypto_connections')).toHaveLength(0);
  });

  describe('delete', () => {
    const seedData = async (connectionId: number) => {
      await db('crypto_raw_records').insert({
        connection_id: connectionId,
        record_type: 'trade',
        exchange_record_id: 'T-1',
        occurred_at: new Date('2026-01-01T00:00:00Z'),
        payload: JSON.stringify({ a: 1 }),
        payload_hash: 'a'.repeat(64),
      });
      await db('crypto_balance_snapshots').insert({
        connection_id: connectionId,
        asset: 'BTC',
        free: '1',
        locked: '0',
        captured_at: new Date('2026-01-01T00:00:00Z'),
      });
      await db('crypto_sync_runs').insert({
        connection_id: connectionId,
        kind: 'manual',
        status: 'succeeded',
        started_at: new Date('2026-01-01T00:00:00Z'),
      });
    };
    const counts = async () => ({
      raw: (await db('crypto_raw_records')).length,
      snapshots: (await db('crypto_balance_snapshots')).length,
      runs: (await db('crypto_sync_runs')).length,
    });

    it('keeps raw records, snapshots and runs by default (archives the row)', async () => {
      const accountId = await addAccount();
      const view = await create.execute(dto({ accountId }));
      await settle();
      await seedData(view.id);

      await remove.execute(view.id);
      await settle();

      expect(await counts()).toEqual({ raw: 1, snapshots: 1, runs: 1 });
      const [row] = await db('crypto_connections');
      expect(row).toMatchObject({
        api_key_encrypted: '',
        api_secret_encrypted: '',
        passphrase_encrypted: null,
        account_id: null,
        status: 'paused',
      });
      expect(row.deleted_at).not.toBeNull();
      expect(await repo.findById(view.id)).toBeUndefined();
      // the freed account can be mapped again
      const again = await create.execute(dto({ accountId, label: 'Again' }));
      expect(again.accountId).toBe(accountId);
    });

    it('deletes the data only when deleteData is true', async () => {
      const view = await create.execute(dto());
      await settle();
      await seedData(view.id);

      await remove.execute(view.id, { deleteData: true });
      await settle();

      expect(await counts()).toEqual({ raw: 0, snapshots: 0, runs: 0 });
      expect(await db('crypto_connections')).toHaveLength(0);
    });
  });

  describe('Accounts guard', () => {
    const deleteAccountService = () =>
      new DeleteAccount(
        () => Account,
        { emitAsync: async () => [] } as any,
        new UnitOfWork(() => modelDb),
        { throwErrorIfAccountPredefined: () => undefined } as any,
        () => CryptoConnection,
      );

    it('blocks deleting a mapped account with a friendly error (not a raw FK error)', async () => {
      const accountId = await addAccount();
      await create.execute(dto({ accountId, label: 'Kraken - Trading' }));
      await settle();

      // without the guard the database refuses with a raw foreign-key error
      await expect(
        db('accounts').where({ id: accountId }).delete(),
      ).rejects.toMatchObject({ code: 'ER_ROW_IS_REFERENCED_2' });

      const error = await deleteAccountService()
        .deleteAccount(accountId)
        .catch((e) => e);
      expect(error.errorType).toBe('ACCOUNT_MAPPED_TO_CRYPTO_CONNECTION');
      expect(error.message).toBe(
        'This account is mapped to crypto connection Kraken - Trading',
      );
      expect(await db('accounts').where({ id: accountId })).toHaveLength(1);
    });

    it('no longer blocks once the connection was removed', async () => {
      const accountId = await addAccount();
      const view = await create.execute(dto({ accountId }));
      await settle();
      await remove.execute(view.id);
      await settle();

      await expect(
        (deleteAccountService() as any).validateNotMappedToCryptoConnection(
          accountId,
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe('key_expires_at migration', () => {
    it('adds a nullable column that Create persists', async () => {
      const info = await db('crypto_connections').columnInfo('key_expires_at');
      expect(info).toBeDefined();
      expect(info.nullable).toBe(true);

      adapter.inspection = {
        readOnly: true,
        permissions: [],
        expiresAt: new Date('2027-01-05T00:00:00Z'),
      };
      const view = await create.execute(dto());
      await settle();
      expect(view.keyExpiresAt).toEqual(new Date('2027-01-05T00:00:00Z'));
      const [row] = await db('crypto_connections').where({ id: view.id });
      expect(new Date(row.key_expires_at).toISOString()).toBe(
        '2027-01-05T00:00:00.000Z',
      );
    });

    it('down drops the column and up restores it', async () => {
      const m = migrations()[3];
      await m.down(db);
      expect(
        await db.schema.hasColumn('crypto_connections', 'key_expires_at'),
      ).toBe(false);
      await m.up(db);
      expect(
        await db.schema.hasColumn('crypto_connections', 'key_expires_at'),
      ).toBe(true);
    });
  });
});
