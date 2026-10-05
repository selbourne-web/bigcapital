import { UnprocessableEntityException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { RotateCryptoCredentialsService } from './RotateCryptoCredentials.service';
import { RotateCredentialsDto } from '../dtos/RotateCredentials.dto';
import { cryptoEvents } from '../CryptoExchanges.events';
import {
  ExchangeAuthError,
  KeyHasExtraPermissionsError,
} from '../adapters/errors';
import {
  FAKE_KEY,
  FAKE_PASSPHRASE,
  FAKE_SECRET,
  FakeAccounts,
  FakeAdapter,
  FakeAudit,
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
  const repo = new FakeRepo();
  const { validators, limiter } = makeValidators(
    adapter,
    new FakeAccounts(),
    repo,
  );
  const uow = new FakeUow();
  const audit = new FakeAudit();
  const events = new FakeEvents();
  const vault = makeVault();
  const service = new RotateCryptoCredentialsService(
    repo as any,
    vault,
    validators,
    uow as any,
    audit as any,
    events as any,
    fakeCls(),
  );
  return { adapter, repo, limiter, uow, audit, events, vault, service };
};

const NEW = {
  apiKey: ` ${FAKE_KEY}\n`,
  apiSecret: `${FAKE_SECRET}\n`,
  passphrase: FAKE_PASSPHRASE,
};

describe('RotateCryptoCredentialsService', () => {
  it('re-inspects the new key, stores it encrypted, reactivates and clears the error', async () => {
    const t = setup();
    const c = t.repo.seed({ status: 'error', lastError: 'rejected' });

    const view = await t.service.execute(c.id, NEW);

    expect(t.adapter.inspected[0]).toEqual({
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
      passphrase: FAKE_PASSPHRASE,
    });
    expect(t.limiter.acquire).toHaveBeenCalledWith('kraken', 1);
    const stored = t.repo.rows.get(c.id);
    expect(stored.apiKeyEncrypted).not.toContain(FAKE_KEY);
    expect(t.vault.decrypt(stored.apiKeyEncrypted, stored.keyVersion)).toBe(
      FAKE_KEY,
    );
    expect(stored.keyHint).toBe('7731');
    expect(view).toMatchObject({ status: 'active', lastError: null });
    expect(t.events.emitted).toEqual([
      {
        name: cryptoEvents.connection.credentialsRotated,
        payload: { connectionId: c.id, organizationId: 7, trx: t.uow.trxs[0] },
      },
    ]);
    expect(cryptoEvents.connection.credentialsRotated).toBe(
      'crypto.connection.credentials-rotated',
    );
    expect(t.audit.rows[0]).toMatchObject({
      action: 'credentials_rotated',
      subject: 'CryptoExchange',
      subjectId: c.id,
    });
    expectNoSecrets(view, t.audit.rows, t.events.emitted);
  });

  it.each([
    ['rejected by the exchange', () => new ExchangeAuthError()],
    [
      'has extra permissions',
      () => new KeyHasExtraPermissionsError(['withdraw']),
    ],
  ])('keeps the old credentials when the new key is %s', async (_n, make) => {
    const t = setup();
    const c = t.repo.seed({ status: 'error', lastError: 'rejected' });
    t.adapter.inspection = make();
    const before = { ...t.repo.rows.get(c.id) };

    const error = await t.service.execute(c.id, NEW).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(t.repo.rows.get(c.id)).toEqual(before);
    expect(t.repo.calls).toHaveLength(0);
    expect(t.audit.rows).toHaveLength(0);
    expect(t.events.emitted).toHaveLength(0);
    expectNoSecrets(error);
  });

  it('applies the attestation rule to unverifiable keys', async () => {
    const t = setup();
    const c = t.repo.seed({});
    t.adapter.inspection = { readOnly: 'unverifiable', permissions: [] };

    const error = await t.service.execute(c.id, NEW).catch((e) => e);
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect(error.getResponse()).toEqual({ code: 'ATTESTATION_REQUIRED' });

    const view = await t.service.execute(c.id, {
      ...NEW,
      attestReadOnly: true,
    });
    expect(view.status).toBe('active');
  });

  it('keeps the old credentials when the database update fails', async () => {
    const t = setup();
    const c = t.repo.seed({});
    t.audit.failWith = new Error('audit down');
    await expect(t.service.execute(c.id, NEW)).rejects.toThrow('audit down');
    expect(t.uow.trxs[0].rolledBack).toBe(true);
  });

  it('404s for an unknown connection', async () => {
    const t = setup();
    await expect(t.service.execute(404, NEW)).rejects.toMatchObject({
      errorType: 'CRYPTO_CONNECTION_NOT_FOUND',
    });
    expect(t.adapter.inspected).toHaveLength(0);
  });
});

describe('RotateCredentialsDto', () => {
  it('validates and trims', async () => {
    const o = plainToInstance(RotateCredentialsDto, {
      apiKey: ' a\n',
      apiSecret: 'b',
    });
    expect(o.apiKey).toBe('a');
    expect(await validate(o)).toHaveLength(0);
    expect(
      (
        await validate(
          plainToInstance(RotateCredentialsDto, { apiKey: '', apiSecret: 'b' }),
        )
      ).length,
    ).toBeGreaterThan(0);
  });
});
