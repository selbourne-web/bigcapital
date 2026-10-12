import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ServiceError } from '@/modules/Items/ServiceError';
import { CryptoVault } from '../vault/CryptoVault.service';
import { CreateCsvOnlyConnectionService } from './CreateCsvOnlyConnection.service';
import { CreateCsvOnlyConnectionDto } from '../dtos/CreateCsvOnlyConnection.dto';
import { CreateCryptoConnectionDto } from '../dtos/CreateCryptoConnection.dto';
import {
  CRYPTO_CONNECTION_ERRORS as ERRORS,
  CSV_ONLY_EXCHANGES,
  SUPPORTED_CRYPTO_EXCHANGES,
} from '../CryptoExchanges.constants';
import { assertApiMode } from './assertApiMode';
import {
  FakeAccounts,
  FakeAdapter,
  FakeAudit,
  FakeCreateAccount,
  FakeRepo,
  FakeUow,
  makeValidators,
} from './testFakes';

const setup = () => {
  const adapter = new FakeAdapter();
  const accounts = new FakeAccounts();
  const repo = new FakeRepo();
  const { validators, limiter } = makeValidators(adapter, accounts, repo);
  const uow = new FakeUow();
  const audit = new FakeAudit();
  const createAccount = new FakeCreateAccount(accounts);
  const service = new CreateCsvOnlyConnectionService(
    repo as any,
    validators,
    uow as any,
    createAccount as any,
    audit as any,
  );
  return {
    adapter,
    accounts,
    repo,
    limiter,
    uow,
    audit,
    createAccount,
    service,
  };
};

const dto = (extra: Record<string, unknown> = {}) =>
  ({ exchange: 'nexo', label: 'Nexo', ...extra }) as any;

describe('CreateCsvOnlyConnectionService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('stores a csv_only row with empty credential columns and returns a secret-free view', async () => {
    const t = setup();
    const encrypt = jest.spyOn(CryptoVault.prototype, 'encrypt');

    const view = await t.service.execute(dto({ label: '  Nexo savings  ' }));

    const stored = t.repo.rows.get(view.id);
    expect(stored).toMatchObject({
      exchange: 'nexo',
      label: 'Nexo savings',
      mode: 'csv_only',
      status: 'active',
      apiKeyEncrypted: '',
      apiSecretEncrypted: '',
      passphraseEncrypted: null,
      keyHint: null,
      accountId: null,
    });
    expect(view).toEqual({
      id: view.id,
      exchange: 'nexo',
      label: 'Nexo savings',
      status: 'active',
      mode: 'csv_only',
      keyHint: null,
      accountId: null,
      lastSyncAt: null,
      lastError: null,
      createdAt: stored.createdAt,
      keyExpiresAt: null,
    });
    // no adapter probe, no rate-limit token, no vault
    expect(t.adapter.inspected).toHaveLength(0);
    expect(t.limiter.acquire).not.toHaveBeenCalled();
    expect(encrypt).not.toHaveBeenCalled();
    expect(t.repo.calls).toEqual([`insert@${t.uow.trxs[0].id}`]);
    expect(t.uow.trxs[0].committed).toBe(true);
  });

  it('has no event emitter or scheduler dependency (nothing can be enqueued)', () => {
    // created/scheduling is driven by cryptoEvents.connection.created; this
    // service cannot emit it.
    expect(CreateCsvOnlyConnectionService.length).toBe(5);
  });

  it('writes the same "created" audit entry kind, with mode and no key hint', async () => {
    const t = setup();

    const view = await t.service.execute(dto());

    expect(t.audit.rows).toHaveLength(1);
    expect(t.audit.rows[0]).toMatchObject({
      action: 'created',
      subject: 'CryptoExchange',
      subjectId: view.id,
      trx: t.uow.trxs[0],
    });
    expect(t.audit.rows[0].metadata).toEqual({
      exchange: 'nexo',
      label: 'Nexo',
      mode: 'csv_only',
      accountId: null,
      createdAccount: false,
    });
  });

  it.each(['pionex', 'kraken', 'ftx'])(
    'refuses exchange %s (not CSV-only) and stores nothing',
    async (exchange) => {
      const t = setup();
      await expect(t.service.execute(dto({ exchange }))).rejects.toMatchObject({
        errorType: ERRORS.EXCHANGE_NOT_SUPPORTED,
      });
      expect(t.repo.rows.size).toBe(0);
    },
  );

  it('requires a label', async () => {
    const t = setup();
    await expect(
      t.service.execute(dto({ label: '   ' })),
    ).rejects.toBeInstanceOf(ServiceError);
    expect(t.repo.rows.size).toBe(0);
  });

  describe('account mapping (shared with the key-based create)', () => {
    it('maps an existing asset account', async () => {
      const t = setup();
      t.accounts.add({ id: 11 });
      const view = await t.service.execute(dto({ accountId: 11 }));
      expect(view.accountId).toBe(11);
      expect(t.createAccount.calls).toHaveLength(0);
    });

    it('creates an account named after the label in the same transaction', async () => {
      const t = setup();
      const view = await t.service.execute(dto({ createAccount: true }));
      expect(t.createAccount.calls).toHaveLength(1);
      expect(t.createAccount.calls[0].dto).toMatchObject({
        name: 'Nexo',
        accountType: 'other-current-asset',
      });
      expect(t.createAccount.calls[0].trx).toBe(t.uow.trxs[0]);
      expect(view.accountId).toBe(501);
      expect(t.audit.rows[0].metadata.createdAccount).toBe(true);
    });

    it('rejects both accountId and createAccount', async () => {
      const t = setup();
      t.accounts.add({ id: 11 });
      await expect(
        t.service.execute(dto({ accountId: 11, createAccount: true })),
      ).rejects.toMatchObject({ errorType: ERRORS.ACCOUNT_MAPPING_CONFLICT });
      expect(t.repo.rows.size).toBe(0);
    });

    it('rejects an account already mapped to another connection', async () => {
      const t = setup();
      t.accounts.add({ id: 11 });
      t.repo.seed({ accountId: 11, label: 'Binance - Spot' });
      await expect(
        t.service.execute(dto({ accountId: 11 })),
      ).rejects.toMatchObject({ errorType: ERRORS.ACCOUNT_ALREADY_MAPPED });
      expect(t.repo.rows.size).toBe(1);
    });

    it('rolls back when the account cannot be created', async () => {
      const t = setup();
      t.createAccount.failWith = new ServiceError('account_name_not_unqiue');
      await expect(
        t.service.execute(dto({ createAccount: true })),
      ).rejects.toMatchObject({ errorType: 'account_name_not_unqiue' });
      expect(t.repo.rows.size).toBe(0);
      expect(t.uow.trxs[0].rolledBack).toBe(true);
    });
  });
});

describe('assertApiMode', () => {
  it('passes api-mode rows (and legacy rows without a mode)', () => {
    expect(() => assertApiMode({ mode: 'api' } as any)).not.toThrow();
    expect(() => assertApiMode({} as any)).not.toThrow();
  });

  it('throws a 409 CRYPTO_CONNECTION_CSV_ONLY ServiceError for csv_only rows', () => {
    const error = (() => {
      try {
        assertApiMode({ mode: 'csv_only' } as any);
      } catch (e) {
        return e;
      }
    })() as ServiceError;
    expect(error).toBeInstanceOf(ServiceError);
    expect(error.errorType).toBe('CRYPTO_CONNECTION_CSV_ONLY');
    expect(ERRORS.CONNECTION_CSV_ONLY).toBe('CRYPTO_CONNECTION_CSV_ONLY');
    expect(error.getStatus()).toBe(409);
  });
});

describe('CSV-only exchange constants', () => {
  it('nexo is CSV-only and has no adapter', () => {
    expect([...CSV_ONLY_EXCHANGES]).toEqual(['nexo']);
    expect(SUPPORTED_CRYPTO_EXCHANGES).not.toContain('nexo');
  });
});

describe('CreateCsvOnlyConnectionDto', () => {
  // NOTE: `forbidNonWhitelisted` is stricter than the real app pipe, which only
  // strips unknown fields (so extra credential fields are dropped, not a 400).
  // It is used here to prove the DTO whitelists nothing beyond its own fields.
  const check = async (input: Record<string, unknown>, metatype: any) =>
    validate(plainToInstance(metatype, input), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
  const valid = { exchange: 'nexo', label: 'Nexo' };

  it('accepts a minimal valid body and trims the label', async () => {
    expect(await check(valid, CreateCsvOnlyConnectionDto)).toHaveLength(0);
    expect(
      await check(
        { ...valid, accountId: 3, createAccount: false },
        CreateCsvOnlyConnectionDto,
      ),
    ).toHaveLength(0);
    expect(
      plainToInstance(CreateCsvOnlyConnectionDto, { ...valid, label: ' N ' })
        .label,
    ).toBe('N');
    expect(
      await check(
        { ...valid, label: 'x'.repeat(255) },
        CreateCsvOnlyConnectionDto,
      ),
    ).toHaveLength(0);
  });

  it.each([
    ['an API exchange (pionex)', { exchange: 'pionex' }],
    ['an API exchange (kraken)', { exchange: 'kraken' }],
    ['a missing exchange', { exchange: undefined }],
    ['an empty label', { label: '   ' }],
    ['a label over 255', { label: 'x'.repeat(256) }],
    ['both accountId and createAccount', { accountId: 3, createAccount: true }],
    ['credentials', { apiKey: 'k' }],
  ])('rejects %s', async (_n, patch) => {
    expect(
      (await check({ ...valid, ...patch }, CreateCsvOnlyConnectionDto)).length,
    ).toBeGreaterThan(0);
  });

  it('the key-based create DTO still rejects exchange nexo', async () => {
    expect(
      (
        await check(
          { exchange: 'nexo', label: 'N', apiKey: 'a', apiSecret: 'b' },
          CreateCryptoConnectionDto,
        )
      ).length,
    ).toBeGreaterThan(0);
  });
});
