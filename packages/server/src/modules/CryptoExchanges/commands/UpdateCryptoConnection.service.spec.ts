import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateCryptoConnectionService } from './UpdateCryptoConnection.service';
import { UpdateCryptoConnectionDto } from '../dtos/UpdateCryptoConnection.dto';
import { cryptoEvents } from '../CryptoExchanges.events';
import {
  FakeAccounts,
  FakeAdapter,
  FakeAudit,
  FakeEvents,
  FakeRepo,
  FakeUow,
  expectNoSecrets,
  fakeCls,
  makeValidators,
} from './testFakes';

const setup = () => {
  const adapter = new FakeAdapter();
  const accounts = new FakeAccounts();
  const repo = new FakeRepo();
  const { validators } = makeValidators(adapter, accounts, repo);
  const uow = new FakeUow();
  const audit = new FakeAudit();
  const events = new FakeEvents();
  const service = new UpdateCryptoConnectionService(
    repo as any,
    validators,
    uow as any,
    audit as any,
    events as any,
    fakeCls(),
  );
  return { accounts, repo, uow, audit, events, service };
};

describe('UpdateCryptoConnectionService', () => {
  it('renames and audits the change', async () => {
    const t = setup();
    const c = t.repo.seed({});

    const view = await t.service.execute(c.id, { label: '  Main desk ' });

    expect(view.label).toBe('Main desk');
    expect(t.audit.rows[0]).toMatchObject({
      action: 'edited',
      subject: 'CryptoExchange',
      subjectId: c.id,
    });
    expect(t.audit.rows[0].metadata.changes).toEqual({ label: 'Main desk' });
    expect(t.events.emitted).toHaveLength(0);
  });

  it('pauses and emits crypto.connection.paused', async () => {
    const t = setup();
    const c = t.repo.seed({});

    const view = await t.service.execute(c.id, { status: 'paused' });

    expect(view.status).toBe('paused');
    expect(t.events.emitted).toEqual([
      {
        name: cryptoEvents.connection.paused,
        payload: { connectionId: c.id, organizationId: 7, trx: t.uow.trxs[0] },
      },
    ]);
  });

  it('resumes a paused connection (no last_error) and emits resumed', async () => {
    const t = setup();
    const c = t.repo.seed({ status: 'paused' });

    const view = await t.service.execute(c.id, { status: 'active' });

    expect(view.status).toBe('active');
    expect(view.lastError).toBeNull();
    expect(t.events.emitted[0].name).toBe(cryptoEvents.connection.resumed);
  });

  it('rejects pausing an error connection (error -> paused -> active bypass)', async () => {
    const t = setup();
    const c = t.repo.seed({ status: 'error', lastError: 'bad key' });

    await expect(
      t.service.execute(c.id, { status: 'paused' }),
    ).rejects.toMatchObject({ errorType: 'CRYPTO_CONNECTION_IN_ERROR' });
    expect(t.repo.rows.get(c.id)).toMatchObject({
      status: 'error',
      lastError: 'bad key',
    });
    expect(t.events.emitted).toHaveLength(0);
    expect(t.audit.rows).toHaveLength(0);
  });

  it('refuses to resume a paused connection that still has a last_error', async () => {
    const t = setup();
    const c = t.repo.seed({ status: 'paused', lastError: 'bad key' });

    await expect(
      t.service.execute(c.id, { status: 'active' }),
    ).rejects.toMatchObject({ errorType: 'CRYPTO_CONNECTION_IN_ERROR' });
    expect(t.repo.rows.get(c.id)).toMatchObject({
      status: 'paused',
      lastError: 'bad key',
    });
    expect(t.events.emitted).toHaveLength(0);
  });

  it('still pauses and resumes a healthy connection', async () => {
    const t = setup();
    const c = t.repo.seed({});
    expect((await t.service.execute(c.id, { status: 'paused' })).status).toBe(
      'paused',
    );
    expect((await t.service.execute(c.id, { status: 'active' })).status).toBe(
      'active',
    );
  });

  it('does not resume an error connection (needs rotated credentials)', async () => {
    const t = setup();
    const c = t.repo.seed({ status: 'error', lastError: 'bad key' });

    await expect(
      t.service.execute(c.id, { status: 'active' }),
    ).rejects.toMatchObject({ errorType: 'CRYPTO_CONNECTION_IN_ERROR' });
    expect(t.repo.rows.get(c.id).status).toBe('error');
    expect(t.events.emitted).toHaveLength(0);
  });

  it('is a no-op for a status that is already set', async () => {
    const t = setup();
    const c = t.repo.seed({});
    await t.service.execute(c.id, { status: 'active' });
    expect(t.events.emitted).toHaveLength(0);
  });

  it('sets, changes and clears the account mapping', async () => {
    const t = setup();
    t.accounts.add({ id: 11 });
    t.accounts.add({ id: 12 });
    const c = t.repo.seed({});

    expect((await t.service.execute(c.id, { accountId: 11 })).accountId).toBe(
      11,
    );
    expect((await t.service.execute(c.id, { accountId: 12 })).accountId).toBe(
      12,
    );
    expect(
      (await t.service.execute(c.id, { accountId: null })).accountId,
    ).toBeNull();
    expect(t.audit.rows.map((r) => r.metadata.changes)).toEqual([
      { accountId: 11 },
      { accountId: 12 },
      { accountId: null },
    ]);
  });

  it('re-saving the same account is not reported as already mapped', async () => {
    const t = setup();
    t.accounts.add({ id: 11 });
    const c = t.repo.seed({ accountId: 11 });
    const view = await t.service.execute(c.id, { accountId: 11 });
    expect(view.accountId).toBe(11);
  });

  it('rejects non-asset, mapped-elsewhere and other-currency accounts', async () => {
    const t = setup();
    t.accounts.add({ id: 11, accountRootType: 'expense' });
    t.accounts.add({ id: 12 });
    t.accounts.add({ id: 13, currencyCode: 'EUR' });
    t.repo.seed({ accountId: 12, label: 'Other' });
    const c = t.repo.seed({});

    await expect(
      t.service.execute(c.id, { accountId: 11 }),
    ).rejects.toMatchObject({
      errorType: 'CRYPTO_ACCOUNT_NOT_ASSET',
    });
    await expect(
      t.service.execute(c.id, { accountId: 12 }),
    ).rejects.toMatchObject({
      errorType: 'CRYPTO_ACCOUNT_ALREADY_MAPPED',
    });
    await expect(
      t.service.execute(c.id, { accountId: 13 }),
    ).rejects.toMatchObject({
      errorType: 'CRYPTO_ACCOUNT_CURRENCY_MISMATCH',
    });
    expect(t.repo.rows.get(c.id).accountId).toBeNull();
    expect(t.audit.rows).toHaveLength(0);
  });

  it('404s for an unknown or deleted connection', async () => {
    const t = setup();
    const c = t.repo.seed({ deletedAt: new Date() });
    await expect(t.service.execute(c.id, { label: 'x' })).rejects.toMatchObject(
      {
        errorType: 'CRYPTO_CONNECTION_NOT_FOUND',
      },
    );
    await expect(t.service.execute(999, { label: 'x' })).rejects.toMatchObject({
      errorType: 'CRYPTO_CONNECTION_NOT_FOUND',
    });
  });

  it('never exposes secrets in views or audit metadata', async () => {
    const t = setup();
    const c = t.repo.seed({ apiKeyEncrypted: 'ciphertext-only' });
    const view = await t.service.execute(c.id, { label: 'Renamed' });
    expect(JSON.stringify(view)).not.toContain('ciphertext-only');
    expect(JSON.stringify(t.audit.rows)).not.toContain('ciphertext-only');
    expectNoSecrets(view);
  });
});

describe('UpdateCryptoConnectionDto', () => {
  const check = (input: Record<string, unknown>) =>
    validate(plainToInstance(UpdateCryptoConnectionDto, input));

  it('accepts rename, pause, resume and null accountId', async () => {
    expect(await check({ label: 'x' })).toHaveLength(0);
    expect(await check({ status: 'paused' })).toHaveLength(0);
    expect(await check({ status: 'active' })).toHaveLength(0);
    expect(await check({ accountId: null })).toHaveLength(0);
  });

  it.each([
    ['error status (set only by the system)', { status: 'error' }],
    ['unknown status', { status: 'deleted' }],
    ['empty label', { label: ' ' }],
    ['label too long', { label: 'x'.repeat(101) }],
  ])('rejects %s', async (_n, body) => {
    expect((await check(body)).length).toBeGreaterThan(0);
  });
});
