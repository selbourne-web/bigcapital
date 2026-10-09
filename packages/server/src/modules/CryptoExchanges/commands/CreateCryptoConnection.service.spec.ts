import { UnprocessableEntityException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateCryptoConnectionService } from './CreateCryptoConnection.service';
import { CreateCryptoConnectionDto } from '../dtos/CreateCryptoConnection.dto';
import { cryptoEvents } from '../CryptoExchanges.events';
import { KeyHasExtraPermissionsError } from '../adapters/errors';
import { ServiceError } from '@/modules/Items/ServiceError';
import {
  FAKE_KEY,
  FAKE_PASSPHRASE,
  FAKE_SECRET,
  FakeAccounts,
  FakeAdapter,
  FakeAudit,
  FakeCreateAccount,
  FakeEvents,
  FakeRepo,
  FakeUow,
  expectNoSecrets,
  fakeCls,
  makeValidators,
  makeVault,
} from './testFakes';

const setup = () => {
  const adapter = new FakeAdapter();
  const accounts = new FakeAccounts();
  const repo = new FakeRepo();
  const { validators, limiter } = makeValidators(adapter, accounts, repo);
  const uow = new FakeUow();
  const audit = new FakeAudit();
  const events = new FakeEvents();
  const createAccount = new FakeCreateAccount(accounts);
  const vault = makeVault();
  const service = new CreateCryptoConnectionService(
    repo as any,
    vault,
    validators,
    uow as any,
    createAccount as any,
    audit as any,
    events as any,
    fakeCls(),
  );
  return {
    adapter,
    accounts,
    repo,
    limiter,
    uow,
    audit,
    events,
    createAccount,
    vault,
    service,
  };
};

const dto = (extra: Record<string, unknown> = {}) =>
  ({
    exchange: 'kraken',
    label: 'Kraken - Trading',
    apiKey: FAKE_KEY,
    apiSecret: FAKE_SECRET,
    ...extra,
  }) as any;

describe('CreateCryptoConnectionService', () => {
  it('stores an encrypted, trimmed connection and returns a secret-free view', async () => {
    const t = setup();

    const view = await t.service.execute(
      dto({
        apiKey: `  ${FAKE_KEY}\n`,
        apiSecret: `${FAKE_SECRET}\r\n`,
        passphrase: ` ${FAKE_PASSPHRASE} `,
        label: '  Kraken - Trading  ',
      }),
    );

    // the adapter saw trimmed credentials, via the rate limiter
    expect(t.adapter.inspected[0]).toEqual({
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
      passphrase: FAKE_PASSPHRASE,
    });
    expect(t.limiter.acquire).toHaveBeenCalledWith('kraken', 1);

    const stored = t.repo.rows.get(view.id);
    expect(stored.apiKeyEncrypted).not.toContain(FAKE_KEY);
    expect(t.vault.decrypt(stored.apiKeyEncrypted, stored.keyVersion)).toBe(
      FAKE_KEY,
    );
    expect(t.vault.decrypt(stored.apiSecretEncrypted, stored.keyVersion)).toBe(
      FAKE_SECRET,
    );
    expect(t.vault.decrypt(stored.passphraseEncrypted, stored.keyVersion)).toBe(
      FAKE_PASSPHRASE,
    );
    expect(stored.keyVersion).toBe(1);
    expect(stored.keyHint).toBe('7731');
    expect(stored.label).toBe('Kraken - Trading');

    expect(Object.keys(view).sort()).toEqual(
      [
        'accountId',
        'createdAt',
        'exchange',
        'id',
        'keyExpiresAt',
        'keyHint',
        'label',
        'lastError',
        'lastSyncAt',
        'mode',
        'status',
      ].sort(),
    );
    expect(view).toMatchObject({
      exchange: 'kraken',
      status: 'active',
      keyHint: '7731',
      accountId: null,
    });
    expectNoSecrets(view, t.audit.rows, t.events.emitted);
  });

  it('refuses a key with extra permissions and stores nothing', async () => {
    const t = setup();
    t.adapter.inspection = { readOnly: false, permissions: ['trade'] };

    const error = await t.service.execute(dto()).catch((e) => e);

    expect(error).toBeInstanceOf(KeyHasExtraPermissionsError);
    expect(error.permissions).toEqual(['trade']);
    expect(t.repo.rows.size).toBe(0);
    expect(t.audit.rows).toHaveLength(0);
    expect(t.events.emitted).toHaveLength(0);
    expectNoSecrets(error);
  });

  it('requires attestation (422 ATTESTATION_REQUIRED) for an unverifiable key', async () => {
    const t = setup();
    t.adapter.inspection = { readOnly: 'unverifiable', permissions: [] };

    const error = await t.service.execute(dto()).catch((e) => e);

    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect(error.getStatus()).toBe(422);
    expect(error.getResponse()).toEqual({
      code: 'ATTESTATION_REQUIRED',
      permissions: [],
      warnings: [],
    });
    expect(t.repo.rows.size).toBe(0);

    const view = await t.service.execute(dto({ attestReadOnly: true }));
    expect(view.id).toBeDefined();
    expect(t.repo.rows.size).toBe(1);
  });

  it('persists the key expiry reported by the adapter, null when absent', async () => {
    const t = setup();
    t.adapter.inspection = {
      readOnly: true,
      permissions: ['accounts:read'],
      expiresAt: new Date('2027-01-05T00:00:00Z'),
    };
    const view = await t.service.execute(dto());
    expect(t.repo.rows.get(view.id).keyExpiresAt).toEqual(
      new Date('2027-01-05T00:00:00Z'),
    );
    expect(view.keyExpiresAt).toEqual(new Date('2027-01-05T00:00:00Z'));

    t.adapter.inspection = { readOnly: true, permissions: [] };
    const second = await t.service.execute(dto({ label: 'Second' }));
    expect(t.repo.rows.get(second.id).keyExpiresAt).toBeNull();
  });

  it('does not store the key when the adapter rejects it', async () => {
    const t = setup();
    t.adapter.inspection = new Error('Exchange rejected the API credentials');

    await expect(t.service.execute(dto())).rejects.toThrow(
      'rejected the API credentials',
    );
    expect(t.repo.rows.size).toBe(0);
  });

  it('rejects an unsupported exchange', async () => {
    const t = setup();
    await expect(
      t.service.execute(dto({ exchange: 'nexo' })),
    ).rejects.toMatchObject({ errorType: 'CRYPTO_EXCHANGE_NOT_SUPPORTED' });
  });

  describe('account mapping', () => {
    it('maps an existing asset account in the base currency', async () => {
      const t = setup();
      t.accounts.add({ id: 11 });

      const view = await t.service.execute(dto({ accountId: 11 }));

      expect(view.accountId).toBe(11);
      expect(t.createAccount.calls).toHaveLength(0);
    });

    it.each([
      [
        'non-asset account',
        { accountRootType: 'liability' },
        'CRYPTO_ACCOUNT_NOT_ASSET',
      ],
      ['inactive account', { active: false }, 'CRYPTO_ACCOUNT_INACTIVE'],
      [
        'other-currency account',
        { currencyCode: 'USD' },
        'CRYPTO_ACCOUNT_CURRENCY_MISMATCH',
      ],
    ])('rejects a %s', async (_name, patch, code) => {
      const t = setup();
      t.accounts.add({ id: 11, ...(patch as object) });

      await expect(
        t.service.execute(dto({ accountId: 11 })),
      ).rejects.toMatchObject({ errorType: code });
      expect(t.repo.rows.size).toBe(0);
    });

    it('rejects a missing account', async () => {
      const t = setup();
      await expect(
        t.service.execute(dto({ accountId: 99 })),
      ).rejects.toMatchObject({ errorType: 'CRYPTO_ACCOUNT_NOT_FOUND' });
    });

    it('rejects an account already mapped to another connection', async () => {
      const t = setup();
      t.accounts.add({ id: 11 });
      t.repo.seed({ accountId: 11, label: 'Binance - Spot' });

      const error = await t.service
        .execute(dto({ accountId: 11 }))
        .catch((e) => e);

      expect(error).toBeInstanceOf(ServiceError);
      expect(error.errorType).toBe('CRYPTO_ACCOUNT_ALREADY_MAPPED');
      expect(error.message).toContain('Binance - Spot');
      expect(t.repo.rows.size).toBe(1);
    });

    it('rejects both accountId and createAccount', async () => {
      const t = setup();
      t.accounts.add({ id: 11 });
      await expect(
        t.service.execute(dto({ accountId: 11, createAccount: true })),
      ).rejects.toMatchObject({ errorType: 'CRYPTO_ACCOUNT_MAPPING_CONFLICT' });
      expect(t.adapter.inspected).toHaveLength(0);
    });

    it('creates an asset account named after the label in the same transaction', async () => {
      const t = setup();

      const view = await t.service.execute(dto({ createAccount: true }));

      expect(t.createAccount.calls).toHaveLength(1);
      const { dto: accountDto, trx } = t.createAccount.calls[0];
      expect(accountDto).toMatchObject({
        name: 'Kraken - Trading',
        accountType: 'other-current-asset',
      });
      expect(trx.id).toBe(t.uow.trxs[0].id);
      expect(t.repo.calls).toEqual([`insert@${trx.id}`]);
      expect(view.accountId).toBe(501);
      expect(t.uow.trxs[0].committed).toBe(true);
    });

    it('rolls back (no connection, trx rolled back) when the account cannot be created', async () => {
      const t = setup();
      t.createAccount.failWith = new ServiceError('account_name_not_unqiue');

      await expect(
        t.service.execute(dto({ createAccount: true })),
      ).rejects.toMatchObject({ errorType: 'account_name_not_unqiue' });

      expect(t.repo.rows.size).toBe(0);
      expect(t.uow.trxs[0].rolledBack).toBe(true);
    });

    it('rolls back the whole transaction when a step after account creation fails', async () => {
      const t = setup();
      t.audit.failWith = new Error('audit down');

      await expect(
        t.service.execute(dto({ createAccount: true })),
      ).rejects.toThrow('audit down');

      expect(t.createAccount.calls[0].trx).toBe(t.uow.trxs[0]);
      expect(t.uow.trxs[0].rolledBack).toBe(true);
      expect(t.uow.trxs[0].committed).toBe(false);
    });

    it('stores the connection unmapped when neither is given', async () => {
      const t = setup();
      const view = await t.service.execute(dto());
      expect(view.accountId).toBeNull();
      expect(t.createAccount.calls).toHaveLength(0);
    });
  });

  it('writes an audit row and emits crypto.connection.created in the transaction', async () => {
    const t = setup();

    const view = await t.service.execute(dto({ passphrase: FAKE_PASSPHRASE }));

    expect(t.audit.rows).toHaveLength(1);
    expect(t.audit.rows[0]).toMatchObject({
      action: 'created',
      subject: 'CryptoExchange',
      subjectId: view.id,
      trx: t.uow.trxs[0],
    });
    expect(t.audit.rows[0].metadata).toMatchObject({
      exchange: 'kraken',
      label: 'Kraken - Trading',
      keyHint: '7731',
    });
    expect(t.events.emitted).toEqual([
      {
        name: cryptoEvents.connection.created,
        payload: {
          connectionId: view.id,
          organizationId: 7,
          trx: t.uow.trxs[0],
        },
      },
    ]);
    expect(cryptoEvents.connection.created).toBe('crypto.connection.created');
    expectNoSecrets(
      t.audit.rows.map((r) => r.metadata),
      view,
    );
  });
});

describe('CreateCryptoConnectionDto', () => {
  const check = async (input: Record<string, unknown>) =>
    validate(plainToInstance(CreateCryptoConnectionDto, input), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
  const valid = { exchange: 'kraken', label: 'K', apiKey: 'a', apiSecret: 'b' };

  it('accepts a minimal valid body and trims strings', async () => {
    expect(await check(valid)).toHaveLength(0);
    const o = plainToInstance(CreateCryptoConnectionDto, {
      ...valid,
      apiKey: ' key\n',
    });
    expect(o.apiKey).toBe('key');
  });

  it.each([
    ['unknown exchange', { exchange: 'nexo' }],
    ['empty label', { label: '   ' }],
    ['label too long', { label: 'x'.repeat(101) }],
    ['empty key', { apiKey: ' \n' }],
    ['key too long', { apiKey: 'k'.repeat(513) }],
    ['both accountId and createAccount', { accountId: 3, createAccount: true }],
    ['unknown field', { admin: true }],
  ])('rejects %s', async (_n, patch) => {
    expect((await check({ ...valid, ...patch })).length).toBeGreaterThan(0);
  });

  it('allows createAccount:false together with accountId', async () => {
    expect(
      await check({ ...valid, accountId: 3, createAccount: false }),
    ).toHaveLength(0);
  });
});
